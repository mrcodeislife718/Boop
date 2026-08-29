import { randomUUID } from 'node:crypto';
import { ClosedLoopLedger, type LedgerTransaction } from './ledger.js';

export type PaymentAuthorization = {
  id: string;
  payerAccountId: string;
  payeeAccountId: string;
  amountMinor: bigint;
  currency: string;
  status: 'authorized' | 'captured' | 'released' | 'refunded';
  createdAt: string;
  captureTransactionId?: string;
  refundTransactionId?: string;
};

export class PaymentEngine {
  private readonly authorizations = new Map<string, PaymentAuthorization>();
  constructor(private readonly ledger: ClosedLoopLedger) {}

  authorize(payerAccountId: string, payeeAccountId: string, amountMinor: bigint, currency: string): PaymentAuthorization {
    if (amountMinor <= 0n) throw new Error('amountMinor must be positive');
    if (this.available(payerAccountId) < amountMinor) throw new Error('Insufficient available balance');
    const authorization: PaymentAuthorization = {
      id: randomUUID(), payerAccountId, payeeAccountId, amountMinor, currency,
      status: 'authorized', createdAt: new Date().toISOString(),
    };
    this.authorizations.set(authorization.id, authorization);
    return { ...authorization };
  }

  capture(authorizationId: string, idempotencyKey: string): LedgerTransaction {
    const auth = this.requireAuthorization(authorizationId);
    if (auth.status === 'captured' && auth.captureTransactionId) {
      const existing = this.ledger.history().find((tx) => tx.id === auth.captureTransactionId);
      if (!existing) throw new Error('Captured transaction missing from ledger');
      return existing;
    }
    if (auth.status !== 'authorized') throw new Error(`Cannot capture authorization in ${auth.status} state`);
    const tx = this.ledger.transfer(auth.payerAccountId, auth.payeeAccountId, auth.amountMinor, idempotencyKey, 'payment');
    auth.status = 'captured';
    auth.captureTransactionId = tx.id;
    return tx;
  }

  release(authorizationId: string): PaymentAuthorization {
    const auth = this.requireAuthorization(authorizationId);
    if (auth.status !== 'authorized') throw new Error(`Cannot release authorization in ${auth.status} state`);
    auth.status = 'released';
    return { ...auth };
  }

  refund(authorizationId: string, idempotencyKey: string): LedgerTransaction {
    const auth = this.requireAuthorization(authorizationId);
    if (auth.status !== 'captured') throw new Error(`Cannot refund authorization in ${auth.status} state`);
    const tx = this.ledger.transfer(auth.payeeAccountId, auth.payerAccountId, auth.amountMinor, idempotencyKey, 'refund');
    auth.status = 'refunded';
    auth.refundTransactionId = tx.id;
    return tx;
  }

  available(accountId: string): bigint {
    const held = [...this.authorizations.values()]
      .filter((auth) => auth.payerAccountId === accountId && auth.status === 'authorized')
      .reduce((total, auth) => total + auth.amountMinor, 0n);
    return this.ledger.balance(accountId) - held;
  }

  private requireAuthorization(id: string): PaymentAuthorization {
    const auth = this.authorizations.get(id);
    if (!auth) throw new Error(`Unknown authorization: ${id}`);
    return auth;
  }
}
