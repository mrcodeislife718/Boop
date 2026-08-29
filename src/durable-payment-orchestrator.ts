import type { LedgerTransaction } from './ledger.js';
import { ComplianceRegistry } from './compliance-registry.js';
import { PaymentPolicyEngine } from './payment-policy.js';
import { PostgresPaymentIntentStore } from './postgres-payment-intents.js';
import { PostgresPaymentLifecycle } from './postgres-payment-lifecycle.js';
import { RailFabric, type RailDecision, type RailRequest } from './rail-fabric.js';
import type { PaymentIntent } from './payment-intent.js';

export type DurableExternalExecution = {
  providerReference: string;
  status: 'accepted' | 'succeeded' | 'failed';
  acceptedAt: string;
};

export interface DurableExternalRailExecutor {
  readonly capabilityId: string;
  execute(input: { intent: PaymentIntent; route: RailDecision; idempotencyKey: string }): Promise<DurableExternalExecution>;
}

export type DurablePaymentInput = {
  amountMinor: bigint;
  currency: string;
  payerAccountId: string;
  payeeAccountId: string;
  payerSubjectId: string;
  payeeSubjectId: string;
  jurisdiction: string;
  createIdempotencyKey: string;
  executionIdempotencyKey: string;
  velocityCount24h: number;
  velocityAmount24hMinor: bigint;
  accountAgeMs: number;
  riskScore: number;
  riskReasonCodes: string[];
  riskRulesetVersion: string;
  deviceTrusted: boolean;
  railRequirements?: Omit<RailRequest,'amountMinor'|'currency'|'jurisdiction'>;
  metadata?: Record<string,string>;
};

export type DurablePaymentResult = {
  intent: PaymentIntent;
  route: RailDecision;
  ledgerTransaction?: LedgerTransaction;
  externalExecution?: DurableExternalExecution;
};

export class DurablePaymentOrchestrator {
  private readonly executors = new Map<string,DurableExternalRailExecutor>();

  constructor(
    readonly intents: PostgresPaymentIntentStore,
    readonly lifecycle: PostgresPaymentLifecycle,
    readonly compliance: ComplianceRegistry,
    readonly policy: PaymentPolicyEngine,
    readonly rails: RailFabric,
  ) {}

  registerExternalExecutor(executor: DurableExternalRailExecutor): void {
    if (!executor.capabilityId.trim()) throw new Error('External executor capabilityId is required');
    if (this.executors.has(executor.capabilityId)) throw new Error(`External executor already registered: ${executor.capabilityId}`);
    this.executors.set(executor.capabilityId, executor);
  }

  async execute(input: DurablePaymentInput): Promise<DurablePaymentResult> {
    let intent = await this.intents.create({
      amountMinor: input.amountMinor, currency: input.currency, payerAccountId: input.payerAccountId,
      payeeAccountId: input.payeeAccountId, metadata: input.metadata ?? {},
    }, input.createIdempotencyKey);

    if (intent.status === 'succeeded' || intent.status === 'processing') return { intent, route: this.resolveRoute(intent) };
    if (['failed','cancelled','partially-refunded','refunded'].includes(intent.status)) throw new Error(`Payment intent is terminal for execution: ${intent.status}`);

    if (intent.status === 'requires-authorization') {
      const [payer, payee] = await Promise.all([
        this.compliance.requireCurrentProfile(input.payerSubjectId),
        this.compliance.requireCurrentProfile(input.payeeSubjectId),
      ]);
      if (payer.sanctionsStatus !== 'clear' || payee.sanctionsStatus !== 'clear') throw new Error('Payment blocked because sanctions status is not clear');
      const riskDecision = await this.compliance.recordRiskDecision({
        subjectId: input.payerSubjectId, paymentIntentId: intent.id, riskScore: input.riskScore,
        decision: input.riskScore > 0.8 ? 'deny' : input.riskScore > 0.5 ? 'review' : 'allow',
        reasonCodes: input.riskReasonCodes, modelOrRulesetVersion: input.riskRulesetVersion,
      });
      const decision = this.policy.evaluate({
        payerAccountId: input.payerAccountId, payeeAccountId: input.payeeAccountId, amountMinor: input.amountMinor,
        currency: input.currency, jurisdiction: input.jurisdiction, payerVerification: payer.verificationLevel,
        payeeVerification: payee.verificationLevel, velocityCount24h: input.velocityCount24h,
        velocityAmount24hMinor: input.velocityAmount24hMinor, accountAgeMs: input.accountAgeMs,
        riskScore: riskDecision.riskScore, sanctionsClear: true, deviceTrusted: input.deviceTrusted,
      });
      if (!decision.allowed) {
        await this.intents.transition(intent.id,'failed',decision.reasons.join(',') || 'policy-denied',{ failureCode: decision.requiresReview ? 'policy-review-required' : 'policy-denied' });
        throw new Error(`Payment denied: ${decision.reasons.join(',')}`);
      }
      const route = this.rails.choose({ amountMinor: input.amountMinor, currency: input.currency, jurisdiction: input.jurisdiction, ...(input.railRequirements ?? {}) });
      intent = await this.intents.transition(intent.id,'authorized','policy-approved-and-route-selected',{ routeId: route.capabilityId });
    }

    const route = this.resolveRoute(intent);
    if (route.railType === 'internal') {
      const authorization = await this.lifecycle.authorize({
        payerAccountId: intent.payerAccountId, payeeAccountId: intent.payeeAccountId, amountMinor: intent.amountMinor,
        currency: intent.currency, idempotencyKey: `intent-auth:${intent.id}`,
      });
      intent = await this.intents.transition(intent.id,'processing','internal-authorization-created',{ authorizationId: authorization.id, routeId: route.capabilityId });
      const capture = await this.lifecycle.capture(authorization.id,intent.amountMinor,input.executionIdempotencyKey);
      const succeeded = await this.intents.transition(intent.id,'succeeded','internal-ledger-capture-succeeded',{ capturedMinor: intent.amountMinor, authorizationId: authorization.id, routeId: route.capabilityId });
      return { intent: succeeded, route, ledgerTransaction: capture.transaction };
    }

    const executor = this.executors.get(route.capabilityId);
    if (!executor) {
      await this.intents.transition(intent.id,'failed','rail-executor-unavailable',{ failureCode: 'rail-executor-unavailable', routeId: route.capabilityId });
      throw new Error(`No external executor registered for ${route.capabilityId}`);
    }
    intent = await this.intents.transition(intent.id,'processing','external-rail-execution-started',{ routeId: route.capabilityId });
    const externalExecution = await executor.execute({ intent, route, idempotencyKey: input.executionIdempotencyKey });
    if (externalExecution.status === 'accepted') return { intent, route, externalExecution };
    return this.recordExternalResult(intent.id, externalExecution);
  }

  async recordExternalResult(intentId: string, execution: DurableExternalExecution): Promise<DurablePaymentResult> {
    const intent = await this.intents.require(intentId);
    const route = this.resolveRoute(intent);
    if (route.railType === 'internal') throw new Error('External result cannot be applied to an internal payment');
    if (intent.status === 'succeeded') return { intent, route, externalExecution: execution };
    if (intent.status !== 'processing') throw new Error(`External result cannot be applied while intent is ${intent.status}`);
    if (execution.status === 'accepted') return { intent, route, externalExecution: execution };
    if (execution.status === 'failed') {
      await this.intents.transition(intent.id,'failed','external-rail-failed',{ failureCode: 'external-rail-failed', externalReference: execution.providerReference });
      throw new Error(`External rail failed: ${route.provider}`);
    }
    const succeeded = await this.intents.transition(intent.id,'succeeded','external-rail-succeeded',{ capturedMinor: intent.amountMinor, externalReference: execution.providerReference, routeId: route.capabilityId });
    return { intent: succeeded, route, externalExecution: execution };
  }

  async refundInternal(intentId: string, amountMinor: bigint, idempotencyKey: string, reason: string): Promise<{ intent: PaymentIntent; transaction: LedgerTransaction }> {
    const intent = await this.intents.require(intentId);
    const route = this.resolveRoute(intent);
    if (route.railType !== 'internal') throw new Error('External rail refunds must be executed through the selected rail adapter');
    if (!intent.authorizationId) throw new Error('Internal payment is missing authorization identity');
    if (intent.status !== 'succeeded' && intent.status !== 'partially-refunded') throw new Error(`Cannot refund intent in ${intent.status} state`);
    const remaining = intent.capturedMinor - intent.refundedMinor;
    if (amountMinor <= 0n || amountMinor > remaining) throw new Error('Refund amount exceeds refundable value');
    const refund = await this.lifecycle.refund(intent.authorizationId, amountMinor, idempotencyKey, reason);
    const refundedMinor = intent.refundedMinor + amountMinor;
    const nextStatus = refundedMinor === intent.capturedMinor ? 'refunded' : 'partially-refunded';
    const updated = await this.intents.transition(intent.id,nextStatus,'internal-refund-posted',{ refundedMinor });
    return { intent: updated, transaction: refund.transaction };
  }

  private resolveRoute(intent: PaymentIntent): RailDecision {
    if (!intent.routeId) throw new Error('Payment intent is missing route identity');
    return this.rails.decisionFor(intent.routeId,intent.amountMinor);
  }
}
