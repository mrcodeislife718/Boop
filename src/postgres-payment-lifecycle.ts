import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { PostgresClosedLoopLedger } from './postgres-ledger.js';
import type { LedgerTransaction } from './ledger.js';

export type DurableAuthorization = {
  id: string;
  payerAccountId: string;
  payeeAccountId: string;
  amountMinor: bigint;
  capturedMinor: bigint;
  currency: string;
  status: 'authorized' | 'partially-captured' | 'captured' | 'released' | 'expired';
  createdAt: string;
  expiresAt?: string;
};

export type CaptureAllocation = { accountId: string; amountMinor: bigint; role: string };
export type CaptureResult = { authorization: DurableAuthorization; transaction: LedgerTransaction; capturedMinor: bigint };
export type RefundResult = { authorization: DurableAuthorization; transaction: LedgerTransaction; refundedMinor: bigint };

export type DurablePayout = {
  id: string;
  sourceAccountId: string;
  clearingAccountId: string;
  amountMinor: bigint;
  currency: string;
  destinationReference: string;
  railCapabilityId: string;
  status: 'created' | 'processing' | 'succeeded' | 'failed' | 'reversed';
  ledgerTransactionId?: string;
  externalReference?: string;
  createdAt: string;
  updatedAt: string;
};

export type DurableDispute = {
  id: string;
  authorizationId: string;
  disputedMinor: bigint;
  currency: string;
  reasonCode: string;
  status: 'opened' | 'evidence-submitted' | 'won' | 'lost' | 'closed';
  provisionalTransactionId?: string;
  resolutionTransactionId?: string;
  openedAt: string;
  resolvedAt?: string;
};

const assertPositive = (value: bigint, label: string): void => {
  if (value <= 0n) throw new Error(`${label} must be positive`);
};

export class PostgresPaymentLifecycle {
  constructor(readonly ledger: PostgresClosedLoopLedger) {}

  async authorize(input: {
    payerAccountId: string;
    payeeAccountId: string;
    amountMinor: bigint;
    currency: string;
    idempotencyKey: string;
    expiresAt?: string;
  }): Promise<DurableAuthorization> {
    assertPositive(input.amountMinor, 'amountMinor');
    if (!input.idempotencyKey.trim()) throw new Error('idempotencyKey is required');
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error('currency must be an uppercase ISO-style code');
    if (input.payerAccountId === input.payeeAccountId) throw new Error('payer and payee must differ');
    if (input.expiresAt && !Number.isFinite(Date.parse(input.expiresAt))) throw new Error('expiresAt is invalid');

    return this.ledger.runSerializable(async (client) => {
      const existing = await client.query('SELECT * FROM boop_authorization_holds WHERE idempotency_key=$1', [input.idempotencyKey]);
      if (existing.rowCount) {
        const auth = this.rowToAuthorization(existing.rows[0]);
        this.assertAuthorizationReplay(auth, input);
        return auth;
      }
      const accounts = await this.ledger.lockAccountsInTransaction(client, [input.payerAccountId, input.payeeAccountId], 'update');
      if (accounts.some((account) => account.currency !== input.currency)) throw new Error('Authorization currency does not match ledger accounts');
      const balance = await this.ledger.balanceInTransaction(client, input.payerAccountId);
      const held = await client.query(
        `SELECT COALESCE(SUM(amount_minor-captured_minor),0)::text AS held
         FROM boop_authorization_holds
         WHERE payer_account_id=$1 AND status IN ('authorized','partially-captured')
           AND (expires_at IS NULL OR expires_at > now())`,
        [input.payerAccountId],
      );
      if (balance - BigInt(held.rows[0].held) < input.amountMinor) throw new Error('Insufficient available balance');
      const id = randomUUID();
      const result = await client.query(
        `INSERT INTO boop_authorization_holds
         (id,payer_account_id,payee_account_id,amount_minor,captured_minor,currency,status,expires_at,idempotency_key)
         VALUES ($1,$2,$3,$4::numeric,0,$5,'authorized',$6,$7) RETURNING *`,
        [id,input.payerAccountId,input.payeeAccountId,input.amountMinor.toString(),input.currency,input.expiresAt ? new Date(input.expiresAt).toISOString() : null,input.idempotencyKey],
      );
      return this.rowToAuthorization(result.rows[0]);
    });
  }

  async release(authorizationId: string): Promise<DurableAuthorization> {
    return this.ledger.runSerializable(async (client) => {
      const auth = await this.lockAuthorization(client, authorizationId);
      if (auth.status !== 'authorized' && auth.status !== 'partially-captured') throw new Error(`Cannot release ${auth.status} authorization`);
      if (auth.capturedMinor > 0n) throw new Error('Partially captured authorization cannot release captured value; only the uncaptured remainder is released');
      const result = await client.query(`UPDATE boop_authorization_holds SET status='released' WHERE id=$1 RETURNING *`, [authorizationId]);
      return this.rowToAuthorization(result.rows[0]);
    });
  }

  async capture(authorizationId: string, amountMinor: bigint, idempotencyKey: string): Promise<CaptureResult> {
    const auth = await this.getAuthorization(authorizationId);
    return this.captureWithAllocations(authorizationId, amountMinor, [{ accountId: auth.payeeAccountId, amountMinor, role: 'payee' }], idempotencyKey);
  }

  async captureWithAllocations(authorizationId: string, amountMinor: bigint, allocations: CaptureAllocation[], idempotencyKey: string): Promise<CaptureResult> {
    assertPositive(amountMinor, 'capture amount');
    if (!idempotencyKey.trim()) throw new Error('idempotencyKey is required');
    if (!allocations.length || allocations.some((allocation) => allocation.amountMinor <= 0n || !allocation.role.trim())) throw new Error('Capture allocations must be positive and named');
    if (allocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0n) !== amountMinor) throw new Error('Capture allocations must equal capture amount');

    return this.ledger.runSerializable(async (client) => {
      const prior = await client.query(
        `SELECT c.amount_minor::text,t.id,t.idempotency_key,t.kind,t.currency,t.created_at,t.metadata,t.previous_hash,t.hash,p.sequence,p.account_id,p.amount_minor::text AS posting_amount
         FROM boop_authorization_captures c
         JOIN boop_ledger_transactions t ON t.id=c.transaction_id
         JOIN boop_ledger_postings p ON p.transaction_id=t.id
         WHERE c.idempotency_key=$1 ORDER BY p.sequence`,
        [idempotencyKey],
      );
      if (prior.rowCount) {
        const priorAmount = BigInt(prior.rows[0].amount_minor);
        if (priorAmount !== amountMinor) throw new Error('Capture idempotency key reused with different amount');
        const transaction = this.transactionFromCaptureRows(prior.rows);
        const authorization = await this.lockAuthorization(client, authorizationId);
        return { authorization, transaction, capturedMinor: priorAmount };
      }

      const auth = await this.lockAuthorization(client, authorizationId);
      if (auth.status !== 'authorized' && auth.status !== 'partially-captured') throw new Error(`Cannot capture ${auth.status} authorization`);
      if (auth.expiresAt && Date.parse(auth.expiresAt) <= Date.now()) {
        await client.query(`UPDATE boop_authorization_holds SET status='expired' WHERE id=$1`, [authorizationId]);
        throw new Error('Authorization has expired');
      }
      const remaining = auth.amountMinor - auth.capturedMinor;
      if (amountMinor > remaining) throw new Error('Capture exceeds remaining authorized amount');
      const accountIds = [auth.payerAccountId, ...allocations.map((allocation) => allocation.accountId)];
      const accounts = await this.ledger.lockAccountsInTransaction(client, accountIds, 'update');
      if (accounts.some((account) => account.currency !== auth.currency)) throw new Error('Capture allocation currency mismatch');
      const balance = await this.ledger.balanceInTransaction(client, auth.payerAccountId);
      if (balance < amountMinor) throw new Error('Authorized funds are no longer available');

      const transaction = await this.ledger.postInTransaction(client, {
        idempotencyKey,
        kind: 'payment',
        currency: auth.currency,
        postings: [
          { accountId: auth.payerAccountId, amountMinor: -amountMinor },
          ...allocations.map((allocation) => ({ accountId: allocation.accountId, amountMinor: allocation.amountMinor })),
        ],
        metadata: Object.fromEntries(allocations.map((allocation, index) => [`allocation_${index}`, `${allocation.role}:${allocation.accountId}:${allocation.amountMinor}`])),
      }, false);
      const capturedMinor = auth.capturedMinor + amountMinor;
      const status = capturedMinor === auth.amountMinor ? 'captured' : 'partially-captured';
      const updated = await client.query(
        `UPDATE boop_authorization_holds SET captured_minor=$2::numeric,status=$3,capture_transaction_id=$4 WHERE id=$1 RETURNING *`,
        [authorizationId,capturedMinor.toString(),status,transaction.id],
      );
      await client.query(
        `INSERT INTO boop_authorization_captures (id,authorization_id,transaction_id,amount_minor,idempotency_key) VALUES ($1,$2,$3,$4::numeric,$5)`,
        [randomUUID(),authorizationId,transaction.id,amountMinor.toString(),idempotencyKey],
      );
      return { authorization: this.rowToAuthorization(updated.rows[0]), transaction, capturedMinor: amountMinor };
    });
  }

  async refund(authorizationId: string, amountMinor: bigint, idempotencyKey: string, reason: string): Promise<RefundResult> {
    assertPositive(amountMinor, 'refund amount');
    if (!idempotencyKey.trim() || !reason.trim()) throw new Error('Refund idempotency key and reason are required');
    return this.ledger.runSerializable(async (client) => {
      const prior = await client.query(
        `SELECT r.amount_minor::text,t.id,t.idempotency_key,t.kind,t.currency,t.created_at,t.metadata,t.previous_hash,t.hash,p.sequence,p.account_id,p.amount_minor::text AS posting_amount
         FROM boop_refunds r JOIN boop_ledger_transactions t ON t.id=r.transaction_id JOIN boop_ledger_postings p ON p.transaction_id=t.id
         WHERE r.idempotency_key=$1 ORDER BY p.sequence`, [idempotencyKey],
      );
      if (prior.rowCount) {
        const priorAmount = BigInt(prior.rows[0].amount_minor);
        if (priorAmount !== amountMinor) throw new Error('Refund idempotency key reused with different amount');
        return { authorization: await this.lockAuthorization(client, authorizationId), transaction: this.transactionFromCaptureRows(prior.rows), refundedMinor: priorAmount };
      }
      const auth = await this.lockAuthorization(client, authorizationId);
      if (auth.capturedMinor <= 0n) throw new Error('Authorization has no captured value to refund');
      const refunded = await client.query(`SELECT COALESCE(SUM(amount_minor),0)::text AS refunded FROM boop_refunds WHERE authorization_id=$1`, [authorizationId]);
      const refundable = auth.capturedMinor - BigInt(refunded.rows[0].refunded);
      if (amountMinor > refundable) throw new Error('Refund exceeds captured unrefunded amount');
      await this.ledger.lockAccountsInTransaction(client, [auth.payeeAccountId, auth.payerAccountId], 'update');
      const payeeBalance = await this.ledger.balanceInTransaction(client, auth.payeeAccountId);
      if (payeeBalance < amountMinor) throw new Error('Payee balance is insufficient for refund; use an approved reserve funding flow');
      const transaction = await this.ledger.postInTransaction(client, {
        idempotencyKey, kind: 'refund', currency: auth.currency,
        postings: [{ accountId: auth.payeeAccountId, amountMinor: -amountMinor }, { accountId: auth.payerAccountId, amountMinor }],
        metadata: { authorizationId, reason },
      }, false);
      await client.query(
        `INSERT INTO boop_refunds (id,authorization_id,transaction_id,amount_minor,idempotency_key,reason) VALUES ($1,$2,$3,$4::numeric,$5,$6)`,
        [randomUUID(),authorizationId,transaction.id,amountMinor.toString(),idempotencyKey,reason],
      );
      return { authorization: auth, transaction, refundedMinor: amountMinor };
    });
  }

  async createPayout(input: {
    sourceAccountId: string;
    clearingAccountId: string;
    amountMinor: bigint;
    currency: string;
    destinationReference: string;
    railCapabilityId: string;
    idempotencyKey: string;
  }): Promise<DurablePayout> {
    assertPositive(input.amountMinor, 'payout amount');
    if (![input.destinationReference,input.railCapabilityId,input.idempotencyKey].every((value) => value.trim())) throw new Error('Payout destination, rail, and idempotency key are required');
    return this.ledger.runSerializable(async (client) => {
      const prior = await client.query('SELECT * FROM boop_payouts WHERE idempotency_key=$1', [input.idempotencyKey]);
      if (prior.rowCount) return this.rowToPayout(prior.rows[0]);
      const accounts = await this.ledger.lockAccountsInTransaction(client, [input.sourceAccountId,input.clearingAccountId], 'update');
      if (accounts.some((account) => account.currency !== input.currency)) throw new Error('Payout account currency mismatch');
      const balance = await this.ledger.balanceInTransaction(client, input.sourceAccountId);
      if (balance < input.amountMinor) throw new Error('Insufficient payout balance');
      const transaction = await this.ledger.postInTransaction(client, {
        idempotencyKey: `payout-ledger:${input.idempotencyKey}`, kind: 'payout', currency: input.currency,
        postings: [{ accountId: input.sourceAccountId, amountMinor: -input.amountMinor }, { accountId: input.clearingAccountId, amountMinor: input.amountMinor }],
        metadata: { destinationReference: input.destinationReference, railCapabilityId: input.railCapabilityId },
      }, false);
      const id = randomUUID();
      const result = await client.query(
        `INSERT INTO boop_payouts
         (id,source_account_id,clearing_account_id,amount_minor,currency,destination_reference,rail_capability_id,status,ledger_transaction_id,idempotency_key)
         VALUES ($1,$2,$3,$4::numeric,$5,$6,$7,'processing',$8,$9) RETURNING *`,
        [id,input.sourceAccountId,input.clearingAccountId,input.amountMinor.toString(),input.currency,input.destinationReference,input.railCapabilityId,transaction.id,input.idempotencyKey],
      );
      return this.rowToPayout(result.rows[0]);
    });
  }

  async recordPayoutResult(payoutId: string, status: 'succeeded' | 'failed', externalReference: string): Promise<DurablePayout> {
    if (!externalReference.trim()) throw new Error('externalReference is required');
    const result = await this.ledger.pool.query(
      `UPDATE boop_payouts SET status=$2,external_reference=$3,updated_at=now() WHERE id=$1 AND status='processing' RETURNING *`,
      [payoutId,status,externalReference],
    );
    if (!result.rowCount) throw new Error('Payout is missing or not processing');
    return this.rowToPayout(result.rows[0]);
  }

  async openDispute(input: {
    authorizationId: string;
    disputedMinor: bigint;
    reasonCode: string;
    idempotencyKey: string;
    provisionalSourceAccountId?: string;
  }): Promise<DurableDispute> {
    assertPositive(input.disputedMinor, 'disputed amount');
    if (!input.reasonCode.trim() || !input.idempotencyKey.trim()) throw new Error('Dispute reason and idempotency key are required');
    return this.ledger.runSerializable(async (client) => {
      const prior = await client.query('SELECT * FROM boop_disputes WHERE idempotency_key=$1', [input.idempotencyKey]);
      if (prior.rowCount) return this.rowToDispute(prior.rows[0]);
      const auth = await this.lockAuthorization(client, input.authorizationId);
      const refunded = await client.query(`SELECT COALESCE(SUM(amount_minor),0)::text AS refunded FROM boop_refunds WHERE authorization_id=$1`, [input.authorizationId]);
      const eligible = auth.capturedMinor - BigInt(refunded.rows[0].refunded);
      if (input.disputedMinor > eligible) throw new Error('Dispute exceeds captured unrefunded amount');
      let provisionalTransactionId: string | undefined;
      if (input.provisionalSourceAccountId) {
        await this.ledger.lockAccountsInTransaction(client, [input.provisionalSourceAccountId,auth.payerAccountId], 'update');
        const sourceBalance = await this.ledger.balanceInTransaction(client, input.provisionalSourceAccountId);
        if (sourceBalance < input.disputedMinor) throw new Error('Provisional dispute source has insufficient balance');
        const transaction = await this.ledger.postInTransaction(client, {
          idempotencyKey: `dispute-provisional:${input.idempotencyKey}`, kind: 'adjustment', currency: auth.currency,
          postings: [{ accountId: input.provisionalSourceAccountId, amountMinor: -input.disputedMinor }, { accountId: auth.payerAccountId, amountMinor: input.disputedMinor }],
          metadata: { authorizationId: input.authorizationId, dispute: 'provisional-credit' },
        }, false);
        provisionalTransactionId = transaction.id;
      }
      const result = await client.query(
        `INSERT INTO boop_disputes
         (id,authorization_id,disputed_minor,currency,reason_code,status,provisional_transaction_id,idempotency_key)
         VALUES ($1,$2,$3::numeric,$4,$5,'opened',$6,$7) RETURNING *`,
        [randomUUID(),input.authorizationId,input.disputedMinor.toString(),auth.currency,input.reasonCode,provisionalTransactionId ?? null,input.idempotencyKey],
      );
      return this.rowToDispute(result.rows[0]);
    });
  }

  async resolveDispute(disputeId: string, outcome: 'won' | 'lost', idempotencyKey: string, provisionalSourceAccountId?: string): Promise<DurableDispute> {
    if (!idempotencyKey.trim()) throw new Error('idempotencyKey is required');
    return this.ledger.runSerializable(async (client) => {
      const result = await client.query('SELECT * FROM boop_disputes WHERE id=$1 FOR UPDATE', [disputeId]);
      if (!result.rowCount) throw new Error(`Unknown dispute: ${disputeId}`);
      const dispute = this.rowToDispute(result.rows[0]);
      if (dispute.status === 'won' || dispute.status === 'lost' || dispute.status === 'closed') {
        if (dispute.status !== outcome) throw new Error(`Dispute already resolved as ${dispute.status}`);
        return dispute;
      }
      const auth = await this.lockAuthorization(client, dispute.authorizationId);
      let resolutionTransactionId: string | undefined;
      if (outcome === 'won' && dispute.provisionalTransactionId) {
        if (!provisionalSourceAccountId) throw new Error('provisionalSourceAccountId is required to reverse provisional credit');
        await this.ledger.lockAccountsInTransaction(client, [auth.payerAccountId,provisionalSourceAccountId], 'update');
        const payerBalance = await this.ledger.balanceInTransaction(client, auth.payerAccountId);
        if (payerBalance < dispute.disputedMinor) throw new Error('Payer balance cannot fund provisional-credit reversal');
        resolutionTransactionId = (await this.ledger.postInTransaction(client, {
          idempotencyKey, kind: 'adjustment', currency: dispute.currency,
          postings: [{ accountId: auth.payerAccountId, amountMinor: -dispute.disputedMinor }, { accountId: provisionalSourceAccountId, amountMinor: dispute.disputedMinor }],
          metadata: { disputeId, outcome },
        }, false)).id;
      } else if (outcome === 'lost' && !dispute.provisionalTransactionId) {
        await this.ledger.lockAccountsInTransaction(client, [auth.payeeAccountId,auth.payerAccountId], 'update');
        const payeeBalance = await this.ledger.balanceInTransaction(client, auth.payeeAccountId);
        if (payeeBalance < dispute.disputedMinor) throw new Error('Payee cannot fund dispute loss; use an approved dispute reserve flow');
        resolutionTransactionId = (await this.ledger.postInTransaction(client, {
          idempotencyKey, kind: 'refund', currency: dispute.currency,
          postings: [{ accountId: auth.payeeAccountId, amountMinor: -dispute.disputedMinor }, { accountId: auth.payerAccountId, amountMinor: dispute.disputedMinor }],
          metadata: { disputeId, outcome },
        }, false)).id;
      }
      const updated = await client.query(
        `UPDATE boop_disputes SET status=$2,resolution_transaction_id=$3,resolved_at=now() WHERE id=$1 RETURNING *`,
        [disputeId,outcome,resolutionTransactionId ?? null],
      );
      return this.rowToDispute(updated.rows[0]);
    });
  }

  async getAuthorization(id: string): Promise<DurableAuthorization> {
    const result = await this.ledger.pool.query('SELECT * FROM boop_authorization_holds WHERE id=$1', [id]);
    if (!result.rowCount) throw new Error(`Unknown authorization: ${id}`);
    return this.rowToAuthorization(result.rows[0]);
  }

  private async lockAuthorization(client: PoolClient, id: string): Promise<DurableAuthorization> {
    const result = await client.query('SELECT * FROM boop_authorization_holds WHERE id=$1 FOR UPDATE', [id]);
    if (!result.rowCount) throw new Error(`Unknown authorization: ${id}`);
    return this.rowToAuthorization(result.rows[0]);
  }

  private assertAuthorizationReplay(auth: DurableAuthorization, input: { payerAccountId: string; payeeAccountId: string; amountMinor: bigint; currency: string }): void {
    if (auth.payerAccountId !== input.payerAccountId || auth.payeeAccountId !== input.payeeAccountId || auth.amountMinor !== input.amountMinor || auth.currency !== input.currency) {
      throw new Error('Authorization idempotency key reused with different parameters');
    }
  }

  private rowToAuthorization(row: any): DurableAuthorization {
    return {
      id: row.id, payerAccountId: row.payer_account_id, payeeAccountId: row.payee_account_id,
      amountMinor: BigInt(row.amount_minor), capturedMinor: BigInt(row.captured_minor ?? 0), currency: row.currency,
      status: row.status, createdAt: new Date(row.created_at).toISOString(), expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : undefined,
    };
  }

  private rowToPayout(row: any): DurablePayout {
    return {
      id: row.id, sourceAccountId: row.source_account_id, clearingAccountId: row.clearing_account_id,
      amountMinor: BigInt(row.amount_minor), currency: row.currency, destinationReference: row.destination_reference,
      railCapabilityId: row.rail_capability_id, status: row.status, ledgerTransactionId: row.ledger_transaction_id ?? undefined,
      externalReference: row.external_reference ?? undefined, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private rowToDispute(row: any): DurableDispute {
    return {
      id: row.id, authorizationId: row.authorization_id, disputedMinor: BigInt(row.disputed_minor), currency: row.currency,
      reasonCode: row.reason_code, status: row.status, provisionalTransactionId: row.provisional_transaction_id ?? undefined,
      resolutionTransactionId: row.resolution_transaction_id ?? undefined, openedAt: new Date(row.opened_at).toISOString(), resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : undefined,
    };
  }

  private transactionFromCaptureRows(rows: any[]): LedgerTransaction {
    return {
      id: rows[0].id, idempotencyKey: rows[0].idempotency_key, kind: rows[0].kind, currency: rows[0].currency,
      createdAt: new Date(rows[0].created_at).toISOString(), metadata: rows[0].metadata ?? {}, previousHash: rows[0].previous_hash, hash: rows[0].hash,
      postings: rows.map((row) => ({ accountId: row.account_id, amountMinor: BigInt(row.posting_amount) })),
    };
  }
}
