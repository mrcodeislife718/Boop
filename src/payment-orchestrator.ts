import type { LedgerTransaction } from './ledger.js';
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
  execute(input: { intent: PaymentIntent; route: RailDecision; idempotencyKey: string }): Promise<ExternalRailExecution>;
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
    let intent = this.intents.create({
      amountMinor: input.amountMinor,
      currency: input.currency,
      payerAccountId: input.payerAccountId,
      payeeAccountId: input.payeeAccountId,
      metadata: { ...(input.metadata ?? {}) },
    }, input.createIdempotencyKey);

    this.assertReplayMatches(intent, input);
    if (intent.status === 'succeeded' || intent.status === 'processing') return { intent, route: this.resolveRecordedRoute(intent) };
    if (intent.status === 'failed' || intent.status === 'cancelled' || intent.status === 'refunded') throw new Error(`Payment intent is terminal: ${intent.status}`);

    if (intent.status === 'requires-authorization') {
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
      const route = this.rails.choose({ amountMinor: input.amountMinor, currency: input.currency, jurisdiction: input.jurisdiction, ...(input.railRequirements ?? {}) });
      intent = this.intents.transition(intent.id, 'authorized', 'policy-approved-and-route-selected', { routeId: route.capabilityId });
    }

    const route = this.resolveRecordedRoute(intent);
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
    if (externalExecution.status === 'accepted') return { intent: this.intents.require(intent.id), route, externalExecution };
    return this.recordExternalResult(intent.id, externalExecution);
  }

  recordExternalResult(intentId: string, execution: ExternalRailExecution): ExecutePaymentResult {
    const intent = this.intents.require(intentId);
    if (intent.status === 'succeeded') return { intent, route: this.resolveRecordedRoute(intent), externalExecution: execution };
    if (intent.status !== 'processing') throw new Error(`External result cannot be applied while intent is ${intent.status}`);
    const route = this.resolveRecordedRoute(intent);
    if (route.railType === 'internal') throw new Error('External result cannot be applied to an internal payment');
    if (execution.status === 'accepted') return { intent, route, externalExecution: execution };
    if (execution.status === 'failed') {
      this.intents.transition(intent.id, 'failed', 'external-rail-failed', { failureCode: 'external-rail-failed', externalReference: execution.providerReference });
      throw new Error(`External rail failed: ${route.provider}`);
    }
    const succeeded = this.intents.transition(intent.id, 'succeeded', 'external-rail-succeeded', { capturedMinor: intent.amountMinor, externalReference: execution.providerReference, routeId: route.capabilityId });
    return { intent: succeeded, route, externalExecution: execution };
  }

  private resolveRecordedRoute(intent: PaymentIntent): RailDecision {
    if (!intent.routeId) throw new Error('Payment intent is missing route identity');
    return this.rails.decisionFor(intent.routeId, intent.amountMinor);
  }

  private assertReplayMatches(intent: PaymentIntent, input: ExecutePaymentInput): void {
    if (intent.amountMinor !== input.amountMinor || intent.currency !== input.currency || intent.payerAccountId !== input.payerAccountId || intent.payeeAccountId !== input.payeeAccountId) {
      throw new Error('Idempotency key was reused with different payment parameters');
    }
  }
}
