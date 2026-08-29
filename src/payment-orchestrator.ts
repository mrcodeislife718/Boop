import type { ClosedLoopLedger, LedgerTransaction } from './ledger.js';
import type { PaymentEngine } from './payment-engine.js';
import { PaymentIntentStore, type PaymentIntent } from './payment-intent.js';
import { PaymentPolicyEngine, type PaymentPolicyContext } from './payment-policy.js';
import { RailFabric, type RailDecision, type RailRequest } from './rail-fabric.js';

export type ExternalRailExecution = {
  providerReference: string;
  acceptedAt: string;
  status: 'accepted' | 'succeeded' | 'failed';
};

export interface ExternalRailExecutor {
  readonly capabilityId: string;
  execute(input: {
    intent: PaymentIntent;
    route: RailDecision;
    idempotencyKey: string;
  }): Promise<ExternalRailExecution>;
}

export type ExecutePaymentInput = {
  amountMinor: bigint;
  currency: string;
  payerAccountId: string;
  payeeAccountId: string;
  jurisdiction: string;
  createIdempotencyKey: string;
  executionIdempotencyKey: string;
  policyContext: Omit<PaymentPolicyContext, 'payerAccountId' | 'payeeAccountId' | 'amountMinor' | 'currency' | 'jurisdiction'>;
  railRequirements?: Omit<RailRequest, 'amountMinor' | 'currency' | 'jurisdiction'>;
  metadata?: Record<string, string>;
};

export type ExecutePaymentResult = {
  intent: PaymentIntent;
  route: RailDecision;
  ledgerTransaction?: LedgerTransaction;
  externalExecution?: ExternalRailExecution;
};

export class PaymentOrchestrator {
  readonly intents = new PaymentIntentStore();
  private readonly executors = new Map<string, ExternalRailExecutor>();

  constructor(
    private readonly ledger: ClosedLoopLedger,
    private readonly payments: PaymentEngine,
    private readonly policy: PaymentPolicyEngine,
    private readonly rails: RailFabric,
  ) {}

  registerExternalExecutor(executor: ExternalRailExecutor): void {
    if (!executor.capabilityId.trim()) throw new Error('External rail executor capabilityId is required');
    if (this.executors.has(executor.capabilityId)) throw new Error(`External rail executor already registered: ${executor.capabilityId}`);
    this.executors.set(executor.capabilityId, executor);
  }

  async execute(input: ExecutePaymentInput): Promise<ExecutePaymentResult> {
    const intent = this.intents.create({
      amountMinor: input.amountMinor,
      currency: input.currency,
      payerAccountId: input.payerAccountId,
      payeeAccountId: input.payeeAccountId,
      metadata: { ...(input.metadata ?? {}) },
    }, input.createIdempotencyKey);

    if (intent.status === 'succeeded') {
      const route = this.resolveRecordedRoute(intent);
      return { intent, route };
    }

    const policyDecision = this.policy.evaluate({
      ...input.policyContext,
      payerAccountId: input.payerAccountId,
      payeeAccountId: input.payeeAccountId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      jurisdiction: input.jurisdiction,
    });
    if (!policyDecision.allowed) {
      const failed = this.intents.transition(intent.id, 'failed', policyDecision.reasons.join(','), { failureCode: policyDecision.requiresReview ? 'policy-review-required' : 'policy-denied' });
      throw new Error(`Payment denied: ${failed.failureCode}: ${policyDecision.reasons.join(',')}`);
    }

    const route = this.rails.choose({
      amountMinor: input.amountMinor,
      currency: input.currency,
      jurisdiction: input.jurisdiction,
      ...(input.railRequirements ?? {}),
    });

    this.intents.transition(intent.id, 'authorized', 'policy-approved-and-route-selected', { routeId: route.capabilityId });

    if (route.railType === 'internal') {
      const authorization = this.payments.authorize(input.payerAccountId, input.payeeAccountId, input.amountMinor, input.currency);
      this.intents.transition(intent.id, 'processing', 'internal-authorization-created', { authorizationId: authorization.id, routeId: route.capabilityId });
      const ledgerTransaction = this.payments.capture(authorization.id, input.executionIdempotencyKey);
      const succeeded = this.intents.transition(intent.id, 'succeeded', 'internal-ledger-capture-succeeded', { capturedMinor: input.amountMinor, routeId: route.capabilityId });
      return { intent: succeeded, route, ledgerTransaction };
    }

    const executor = this.executors.get(route.capabilityId);
    if (!executor) {
      this.intents.transition(intent.id, 'failed', 'rail-executor-unavailable', { failureCode: 'rail-executor-unavailable', routeId: route.capabilityId });
      throw new Error(`No production executor registered for rail capability ${route.capabilityId}`);
    }

    this.intents.transition(intent.id, 'processing', 'external-rail-execution-started', { routeId: route.capabilityId });
    const externalExecution = await executor.execute({ intent: this.intents.require(intent.id), route, idempotencyKey: input.executionIdempotencyKey });
    if (externalExecution.status === 'failed') {
      this.intents.transition(intent.id, 'failed', 'external-rail-failed', { failureCode: 'external-rail-failed', externalReference: externalExecution.providerReference });
      throw new Error(`External rail failed: ${route.provider}`);
    }
    if (externalExecution.status !== 'succeeded') {
      return { intent: this.intents.require(intent.id), route, externalExecution };
    }
    const succeeded = this.intents.transition(intent.id, 'succeeded', 'external-rail-succeeded', { capturedMinor: input.amountMinor, externalReference: externalExecution.providerReference, routeId: route.capabilityId });
    return { intent: succeeded, route, externalExecution };
  }

  private resolveRecordedRoute(intent: PaymentIntent): RailDecision {
    if (!intent.routeId) throw new Error('Succeeded payment intent is missing route identity');
    const route = this.rails.route({ amountMinor: intent.amountMinor, currency: intent.currency, jurisdiction: '*'}).find((candidate) => candidate.capabilityId === intent.routeId);
    if (!route) throw new Error(`Recorded rail route is no longer resolvable: ${intent.routeId}`);
    return route;
  }
}
