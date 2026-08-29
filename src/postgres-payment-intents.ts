import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { PaymentIntent, PaymentIntentStatus, PaymentIntentTransition } from './payment-intent.js';

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

type Patch = Partial<Pick<PaymentIntent,'authorizationId'|'routeId'|'externalReference'|'failureCode'|'capturedMinor'|'refundedMinor'>>;

export class PostgresPaymentIntentStore {
  constructor(readonly pool: Pool) {}

  async create(input: {
    amountMinor: bigint;
    currency: string;
    payerAccountId: string;
    payeeAccountId: string;
    metadata?: Record<string,string>;
  }, idempotencyKey: string): Promise<PaymentIntent> {
    if (input.amountMinor <= 0n) throw new Error('amountMinor must be positive');
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error('currency must be an uppercase ISO-style code');
    if (!input.payerAccountId || !input.payeeAccountId || input.payerAccountId === input.payeeAccountId) throw new Error('payer and payee accounts must be distinct and present');
    if (!idempotencyKey.trim()) throw new Error('idempotencyKey is required');
    const id = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO boop_payment_intents
       (id,create_idempotency_key,amount_minor,currency,payer_account_id,payee_account_id,status,metadata)
       VALUES ($1,$2,$3::numeric,$4,$5,$6,'requires-authorization',$7::jsonb)
       ON CONFLICT (create_idempotency_key) DO NOTHING
       RETURNING *`,
      [id,idempotencyKey,input.amountMinor.toString(),input.currency,input.payerAccountId,input.payeeAccountId,JSON.stringify(input.metadata ?? {})],
    );
    const intent = result.rowCount ? this.rowToIntent(result.rows[0]) : await this.requireByIdempotency(idempotencyKey);
    if (intent.amountMinor !== input.amountMinor || intent.currency !== input.currency || intent.payerAccountId !== input.payerAccountId || intent.payeeAccountId !== input.payeeAccountId) {
      throw new Error('Payment intent idempotency key reused with different parameters');
    }
    return intent;
  }

  async transition(id: string, to: PaymentIntentStatus, reason: string, patch: Patch = {}): Promise<PaymentIntent> {
    if (!reason.trim()) throw new Error('Transition reason is required');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const current = await this.requireWithClient(client, id, true);
      if (!transitions[current.status].has(to)) throw new Error(`Invalid payment intent transition ${current.status} -> ${to}`);
      this.validateMoneyPatch(current, to, patch);
      const capturedMinor = patch.capturedMinor ?? current.capturedMinor;
      const refundedMinor = patch.refundedMinor ?? current.refundedMinor;
      const updated = await client.query(
        `UPDATE boop_payment_intents SET
          status=$2,authorization_id=COALESCE($3,authorization_id),route_id=COALESCE($4,route_id),
          external_reference=COALESCE($5,external_reference),failure_code=COALESCE($6,failure_code),
          captured_minor=$7::numeric,refunded_minor=$8::numeric,updated_at=now()
         WHERE id=$1 RETURNING *`,
        [id,to,patch.authorizationId ?? null,patch.routeId ?? null,patch.externalReference ?? null,patch.failureCode ?? null,capturedMinor.toString(),refundedMinor.toString()],
      );
      await client.query(
        `INSERT INTO boop_payment_intent_transitions (intent_id,from_status,to_status,reason,metadata) VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [id,current.status,to,reason,JSON.stringify({ ...patch, capturedMinor: capturedMinor.toString(), refundedMinor: refundedMinor.toString() })],
      );
      await client.query('COMMIT');
      return this.rowToIntent(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async require(id: string): Promise<PaymentIntent> {
    const result = await this.pool.query('SELECT * FROM boop_payment_intents WHERE id=$1', [id]);
    if (!result.rowCount) throw new Error(`Unknown payment intent: ${id}`);
    return this.rowToIntent(result.rows[0]);
  }

  async requireByIdempotency(key: string): Promise<PaymentIntent> {
    const result = await this.pool.query('SELECT * FROM boop_payment_intents WHERE create_idempotency_key=$1', [key]);
    if (!result.rowCount) throw new Error(`Unknown payment intent idempotency key: ${key}`);
    return this.rowToIntent(result.rows[0]);
  }

  async history(id: string): Promise<PaymentIntentTransition[]> {
    await this.require(id);
    const result = await this.pool.query(
      `SELECT from_status,to_status,occurred_at,reason FROM boop_payment_intent_transitions WHERE intent_id=$1 ORDER BY sequence`, [id],
    );
    return result.rows.map((row) => ({ intentId: id, from: row.from_status, to: row.to_status, at: new Date(row.occurred_at).toISOString(), reason: row.reason }));
  }

  private async requireWithClient(client: PoolClient, id: string, lock: boolean): Promise<PaymentIntent> {
    const result = await client.query(`SELECT * FROM boop_payment_intents WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    if (!result.rowCount) throw new Error(`Unknown payment intent: ${id}`);
    return this.rowToIntent(result.rows[0]);
  }

  private validateMoneyPatch(current: PaymentIntent, to: PaymentIntentStatus, patch: Patch): void {
    const captured = patch.capturedMinor ?? current.capturedMinor;
    const refunded = patch.refundedMinor ?? current.refundedMinor;
    if (captured < 0n || captured > current.amountMinor) throw new Error('capturedMinor exceeds payment amount');
    if (refunded < 0n || refunded > captured) throw new Error('refundedMinor exceeds captured amount');
    if (to === 'succeeded' && captured <= 0n) throw new Error('Succeeded payment must have captured value');
    if (to === 'partially-refunded' && !(refunded > 0n && refunded < captured)) throw new Error('Partial refund state requires a partial refund amount');
    if (to === 'refunded' && refunded !== captured) throw new Error('Refunded state requires all captured value to be refunded');
  }

  private rowToIntent(row: any): PaymentIntent {
    return {
      id: row.id, amountMinor: BigInt(row.amount_minor), currency: row.currency,
      payerAccountId: row.payer_account_id, payeeAccountId: row.payee_account_id, status: row.status,
      createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
      authorizationId: row.authorization_id ?? undefined, routeId: row.route_id ?? undefined,
      externalReference: row.external_reference ?? undefined, capturedMinor: BigInt(row.captured_minor), refundedMinor: BigInt(row.refunded_minor),
      failureCode: row.failure_code ?? undefined, metadata: row.metadata ?? {},
    };
  }
}
