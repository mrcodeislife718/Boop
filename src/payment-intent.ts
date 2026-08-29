import { randomUUID } from 'node:crypto';

export type PaymentIntentStatus =
  | 'requires-payment-method'
  | 'requires-authorization'
  | 'authorized'
  | 'processing'
  | 'succeeded'
  | 'cancelled'
  | 'failed'
  | 'partially-refunded'
  | 'refunded';

export type PaymentIntent = {
  id: string;
  amountMinor: bigint;
  currency: string;
  payerAccountId: string;
  payeeAccountId: string;
  status: PaymentIntentStatus;
  createdAt: string;
  updatedAt: string;
  authorizationId?: string;
  routeId?: string;
  externalReference?: string;
  capturedMinor: bigint;
  refundedMinor: bigint;
  failureCode?: string;
  metadata: Record<string, string>;
};

export type PaymentIntentTransition = {
  intentId: string;
  from: PaymentIntentStatus;
  to: PaymentIntentStatus;
  at: string;
  reason: string;
};

const transitions: Record<PaymentIntentStatus, ReadonlySet<PaymentIntentStatus>> = {
  'requires-payment-method': new Set(['requires-authorization', 'cancelled']),
  'requires-authorization': new Set(['authorized', 'failed', 'cancelled']),
  authorized: new Set(['processing', 'succeeded', 'cancelled', 'failed']),
  processing: new Set(['succeeded', 'failed']),
  succeeded: new Set(['partially-refunded', 'refunded']),
  cancelled: new Set(),
  failed: new Set(),
  'partially-refunded': new Set(['partially-refunded', 'refunded']),
  refunded: new Set(),
};

export class PaymentIntentStore {
  private readonly intents = new Map<string, PaymentIntent>();
  private readonly idempotency = new Map<string, string>();
  private readonly transitionLog: PaymentIntentTransition[] = [];

  create(input: Omit<PaymentIntent, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'capturedMinor' | 'refundedMinor'>, idempotencyKey: string): PaymentIntent {
    if (!idempotencyKey.trim()) throw new Error('idempotencyKey is required');
    const existingId = this.idempotency.get(idempotencyKey);
    if (existingId) return this.require(existingId);
    if (input.amountMinor <= 0n) throw new Error('amountMinor must be positive');
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error('currency must be an uppercase ISO-style code');
    if (!input.payerAccountId || !input.payeeAccountId || input.payerAccountId === input.payeeAccountId) {
      throw new Error('payer and payee accounts must be distinct and present');
    }
    const now = new Date().toISOString();
    const intent: PaymentIntent = {
      ...structuredClone(input),
      id: randomUUID(),
      status: 'requires-authorization',
      createdAt: now,
      updatedAt: now,
      capturedMinor: 0n,
      refundedMinor: 0n,
      metadata: { ...input.metadata },
    };
    this.intents.set(intent.id, intent);
    this.idempotency.set(idempotencyKey, intent.id);
    return structuredClone(intent);
  }

  transition(id: string, to: PaymentIntentStatus, reason: string, patch: Partial<Pick<PaymentIntent, 'authorizationId' | 'routeId' | 'externalReference' | 'failureCode' | 'capturedMinor' | 'refundedMinor'>> = {}): PaymentIntent {
    const current = this.getMutable(id);
    if (!transitions[current.status].has(to)) throw new Error(`Invalid payment intent transition ${current.status} -> ${to}`);
    this.validateMoneyPatch(current, to, patch);
    const from = current.status;
    Object.assign(current, patch);
    current.status = to;
    current.updatedAt = new Date().toISOString();
    this.transitionLog.push({ intentId: id, from, to, at: current.updatedAt, reason });
    return structuredClone(current);
  }

  require(id: string): PaymentIntent {
    return structuredClone(this.getMutable(id));
  }

  history(id: string): PaymentIntentTransition[] {
    this.getMutable(id);
    return this.transitionLog.filter((entry) => entry.intentId === id).map((entry) => ({ ...entry }));
  }

  private getMutable(id: string): PaymentIntent {
    const intent = this.intents.get(id);
    if (!intent) throw new Error(`Unknown payment intent: ${id}`);
    return intent;
  }

  private validateMoneyPatch(current: PaymentIntent, to: PaymentIntentStatus, patch: Partial<Pick<PaymentIntent, 'capturedMinor' | 'refundedMinor'>>): void {
    const captured = patch.capturedMinor ?? current.capturedMinor;
    const refunded = patch.refundedMinor ?? current.refundedMinor;
    if (captured < 0n || captured > current.amountMinor) throw new Error('capturedMinor exceeds payment amount');
    if (refunded < 0n || refunded > captured) throw new Error('refundedMinor exceeds captured amount');
    if (to === 'succeeded' && captured <= 0n) throw new Error('Succeeded payment must have captured value');
    if (to === 'partially-refunded' && !(refunded > 0n && refunded < captured)) throw new Error('Partial refund state requires a partial refund amount');
    if (to === 'refunded' && refunded !== captured) throw new Error('Refunded state requires all captured value to be refunded');
  }
}
