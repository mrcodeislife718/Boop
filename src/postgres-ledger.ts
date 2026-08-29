import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { AccountType, LedgerAccount, LedgerTransaction, Posting } from './ledger.js';

export type PostgresLedgerOptions = {
  pool?: Pool;
  connection?: PoolConfig;
};

const txKinds = new Set<LedgerTransaction['kind']>(['topup', 'transfer', 'payment', 'refund', 'payout', 'adjustment']);
const serialize = (value: unknown): string => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry);

export class PostgresClosedLoopLedger {
  readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(options: PostgresLedgerOptions = {}) {
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      this.pool = new Pool(options.connection ?? { connectionString: process.env.DATABASE_URL });
      this.ownsPool = true;
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  async createAccount(ownerId: string, currency: string, type: AccountType = 'liability'): Promise<LedgerAccount> {
    if (!ownerId.trim()) throw new Error('ownerId is required');
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('currency must be an ISO-style uppercase code');
    const id = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO boop_ledger_accounts (id, owner_id, currency, account_type, status)
       VALUES ($1,$2,$3,$4,'active')
       RETURNING id, owner_id, currency, account_type, status`,
      [id, ownerId, currency, type],
    );
    const row = result.rows[0];
    return { id: row.id, ownerId: row.owner_id, currency: row.currency, type: row.account_type, status: row.status };
  }

  async post(input: Omit<LedgerTransaction, 'id' | 'createdAt' | 'previousHash' | 'hash'>): Promise<LedgerTransaction> {
    if (!input.idempotencyKey.trim()) throw new Error('idempotencyKey is required');
    if (!txKinds.has(input.kind)) throw new Error('Unsupported transaction kind');
    if (!input.postings.length || input.postings.length < 2) throw new Error('A transaction requires at least two postings');
    if (input.postings.some((posting) => posting.amountMinor === 0n)) throw new Error('Zero-value postings are not allowed');
    if (input.postings.reduce((sum, posting) => sum + posting.amountMinor, 0n) !== 0n) throw new Error('Ledger transaction must balance to zero');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const existing = await this.findByIdempotency(client, input.idempotencyKey);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }

      await client.query('LOCK TABLE boop_ledger_transactions IN SHARE ROW EXCLUSIVE MODE');
      const accountIds = [...new Set(input.postings.map((posting) => posting.accountId))];
      const accounts = await client.query(
        `SELECT id, currency, status FROM boop_ledger_accounts WHERE id = ANY($1::uuid[]) FOR SHARE`,
        [accountIds],
      );
      if (accounts.rowCount !== accountIds.length) throw new Error('One or more ledger accounts do not exist');
      for (const row of accounts.rows) {
        if (row.status !== 'active') throw new Error(`Account is not active: ${row.id}`);
        if (row.currency !== input.currency) throw new Error('Cross-currency posting requires an explicit FX transaction');
      }

      const head = await client.query(`SELECT hash FROM boop_ledger_transactions ORDER BY created_at DESC, id DESC LIMIT 1`);
      const previousHash = head.rows[0]?.hash ?? 'GENESIS';
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const base = { id, idempotencyKey: input.idempotencyKey, kind: input.kind, currency: input.currency, postings: input.postings, createdAt, metadata: { ...input.metadata }, previousHash };
      const hash = createHash('sha256').update(serialize(base)).digest('hex');

      await client.query(
        `INSERT INTO boop_ledger_transactions (id,idempotency_key,kind,currency,created_at,metadata,previous_hash,hash)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [id, input.idempotencyKey, input.kind, input.currency, createdAt, JSON.stringify(input.metadata), previousHash, hash],
      );
      for (let index = 0; index < input.postings.length; index += 1) {
        const posting = input.postings[index];
        await client.query(
          `INSERT INTO boop_ledger_postings (transaction_id,sequence,account_id,amount_minor) VALUES ($1,$2,$3,$4::numeric)`,
          [id, index, posting.accountId, posting.amountMinor.toString()],
        );
      }
      await client.query('SELECT boop_assert_transaction_balanced($1::uuid)', [id]);
      await client.query('COMMIT');
      return { ...base, hash };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async transfer(fromAccountId: string, toAccountId: string, amountMinor: bigint, idempotencyKey: string, kind: LedgerTransaction['kind'] = 'transfer'): Promise<LedgerTransaction> {
    if (amountMinor <= 0n) throw new Error('amountMinor must be positive');
    if (fromAccountId === toAccountId) throw new Error('Source and destination accounts must be different');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const rows = await client.query(
        `SELECT id, currency, status FROM boop_ledger_accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [[fromAccountId, toAccountId]],
      );
      if (rows.rowCount !== 2) throw new Error('Transfer accounts do not exist');
      if (rows.rows.some((row) => row.status !== 'active')) throw new Error('Transfer account is not active');
      if (new Set(rows.rows.map((row) => row.currency)).size !== 1) throw new Error('Closed-loop transfer accounts must use the same currency');
      const balance = await this.balanceWithClient(client, fromAccountId);
      const held = await client.query(
        `SELECT COALESCE(SUM(amount_minor),0)::text AS held FROM boop_authorization_holds WHERE payer_account_id=$1 AND status='authorized'`,
        [fromAccountId],
      );
      const available = balance - BigInt(held.rows[0].held);
      if (available < amountMinor) throw new Error('Insufficient available balance');
      await client.query('COMMIT');
      return await this.post({
        idempotencyKey,
        kind,
        currency: rows.rows[0].currency,
        postings: [{ accountId: fromAccountId, amountMinor: -amountMinor }, { accountId: toAccountId, amountMinor }],
        metadata: {},
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async balance(accountId: string): Promise<bigint> {
    const result = await this.pool.query('SELECT 1 FROM boop_ledger_accounts WHERE id=$1', [accountId]);
    if (!result.rowCount) throw new Error(`Unknown account: ${accountId}`);
    const client = await this.pool.connect();
    try {
      return await this.balanceWithClient(client, accountId);
    } finally {
      client.release();
    }
  }

  async history(limit = 1000): Promise<LedgerTransaction[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error('limit must be between 1 and 10000');
    const result = await this.pool.query(
      `SELECT t.id,t.idempotency_key,t.kind,t.currency,t.created_at,t.metadata,t.previous_hash,t.hash,
              p.sequence,p.account_id,p.amount_minor::text
       FROM boop_ledger_transactions t
       JOIN boop_ledger_postings p ON p.transaction_id=t.id
       WHERE t.id IN (SELECT id FROM boop_ledger_transactions ORDER BY created_at DESC,id DESC LIMIT $1)
       ORDER BY t.created_at ASC,t.id ASC,p.sequence ASC`,
      [limit],
    );
    const byId = new Map<string, LedgerTransaction>();
    for (const row of result.rows) {
      let tx = byId.get(row.id);
      if (!tx) {
        tx = { id: row.id, idempotencyKey: row.idempotency_key, kind: row.kind, currency: row.currency, postings: [], createdAt: new Date(row.created_at).toISOString(), metadata: row.metadata ?? {}, previousHash: row.previous_hash, hash: row.hash };
        byId.set(row.id, tx);
      }
      tx.postings.push({ accountId: row.account_id, amountMinor: BigInt(row.amount_minor) });
    }
    return [...byId.values()];
  }

  async verifyChain(): Promise<boolean> {
    const history = await this.history(10_000);
    let previousHash = 'GENESIS';
    for (const transaction of history) {
      if (transaction.previousHash !== previousHash) return false;
      const { hash, ...base } = transaction;
      if (createHash('sha256').update(serialize(base)).digest('hex') !== hash) return false;
      previousHash = hash;
    }
    return true;
  }

  private async balanceWithClient(client: PoolClient, accountId: string): Promise<bigint> {
    const result = await client.query(
      `SELECT COALESCE(SUM(p.amount_minor),0)::text AS balance
       FROM boop_ledger_postings p WHERE p.account_id=$1`,
      [accountId],
    );
    return BigInt(result.rows[0].balance);
  }

  private async findByIdempotency(client: PoolClient, key: string): Promise<LedgerTransaction | undefined> {
    const result = await client.query(
      `SELECT t.id,t.idempotency_key,t.kind,t.currency,t.created_at,t.metadata,t.previous_hash,t.hash,
              p.sequence,p.account_id,p.amount_minor::text
       FROM boop_ledger_transactions t
       JOIN boop_ledger_postings p ON p.transaction_id=t.id
       WHERE t.idempotency_key=$1 ORDER BY p.sequence`,
      [key],
    );
    if (!result.rowCount) return undefined;
    const first = result.rows[0];
    return {
      id: first.id,
      idempotencyKey: first.idempotency_key,
      kind: first.kind,
      currency: first.currency,
      postings: result.rows.map((row) => ({ accountId: row.account_id, amountMinor: BigInt(row.amount_minor) } satisfies Posting)),
      createdAt: new Date(first.created_at).toISOString(),
      metadata: first.metadata ?? {},
      previousHash: first.previous_hash,
      hash: first.hash,
    };
  }
}
