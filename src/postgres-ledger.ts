import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { AccountType, LedgerAccount, LedgerTransaction, Posting } from './ledger.js';

export type PostgresLedgerOptions = { pool?: Pool; connection?: PoolConfig; serializationRetries?: number };
export type LedgerPostInput = Omit<LedgerTransaction,'id'|'createdAt'|'previousHash'|'hash'>;

const txKinds = new Set<LedgerTransaction['kind']>(['topup','transfer','payment','refund','payout','adjustment']);
const serialize = (value: unknown): string => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? entry.toString() : entry);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class PostgresClosedLoopLedger {
  readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly serializationRetries: number;

  constructor(options: PostgresLedgerOptions = {}) {
    if (options.pool) { this.pool = options.pool; this.ownsPool = false; }
    else { this.pool = new Pool(options.connection ?? { connectionString: process.env.DATABASE_URL }); this.ownsPool = true; }
    this.serializationRetries = options.serializationRetries ?? 5;
    if (!Number.isInteger(this.serializationRetries) || this.serializationRetries < 0 || this.serializationRetries > 20) throw new Error('serializationRetries must be between 0 and 20');
  }

  async close(): Promise<void> { if (this.ownsPool) await this.pool.end(); }

  async createAccount(ownerId: string, currency: string, type: AccountType = 'liability'): Promise<LedgerAccount> {
    if (!ownerId.trim()) throw new Error('ownerId is required');
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('currency must be an ISO-style uppercase code');
    const id = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO boop_ledger_accounts (id,owner_id,currency,account_type,status) VALUES ($1,$2,$3,$4,'active') RETURNING id,owner_id,currency,account_type,status`,
      [id, ownerId, currency, type],
    );
    return this.rowToAccount(result.rows[0]);
  }

  async setAccountStatus(accountId: string, status: LedgerAccount['status']): Promise<LedgerAccount> {
    const result = await this.pool.query(
      `UPDATE boop_ledger_accounts SET status=$2 WHERE id=$1 RETURNING id,owner_id,currency,account_type,status`,
      [accountId, status],
    );
    if (!result.rowCount) throw new Error(`Unknown account: ${accountId}`);
    return this.rowToAccount(result.rows[0]);
  }

  async post(input: LedgerPostInput): Promise<LedgerTransaction> {
    this.validateInput(input);
    return this.runSerializable((client) => this.postInTransaction(client, input, true));
  }

  async transfer(fromAccountId: string, toAccountId: string, amountMinor: bigint, idempotencyKey: string, kind: LedgerTransaction['kind'] = 'transfer'): Promise<LedgerTransaction> {
    if (amountMinor <= 0n) throw new Error('amountMinor must be positive');
    if (fromAccountId === toAccountId) throw new Error('Source and destination accounts must be different');
    return this.runSerializable(async (client) => {
      const existing = await this.findByIdempotencyInTransaction(client, idempotencyKey);
      if (existing) return existing;
      const accounts = await this.lockAccountsInTransaction(client, [fromAccountId, toAccountId], 'update');
      if (accounts[0].currency !== accounts[1].currency) throw new Error('Closed-loop transfer accounts must use the same currency');
      const balance = await this.balanceInTransaction(client, fromAccountId);
      const held = await client.query(
        `SELECT COALESCE(SUM(amount_minor - captured_minor),0)::text AS held
         FROM boop_authorization_holds
         WHERE payer_account_id=$1 AND status IN ('authorized','partially-captured')`,
        [fromAccountId],
      );
      if (balance - BigInt(held.rows[0].held) < amountMinor) throw new Error('Insufficient available balance');
      return this.postInTransaction(client, {
        idempotencyKey,
        kind,
        currency: accounts[0].currency,
        postings: [{ accountId: fromAccountId, amountMinor: -amountMinor }, { accountId: toAccountId, amountMinor }],
        metadata: {},
      }, false);
    });
  }

  async balance(accountId: string): Promise<bigint> {
    const client = await this.pool.connect();
    try {
      await this.requireAccountInTransaction(client, accountId);
      return await this.balanceInTransaction(client, accountId);
    } finally { client.release(); }
  }

  async availableBalance(accountId: string): Promise<bigint> {
    const client = await this.pool.connect();
    try {
      await this.requireAccountInTransaction(client, accountId);
      const balance = await this.balanceInTransaction(client, accountId);
      const held = await client.query(
        `SELECT COALESCE(SUM(amount_minor - captured_minor),0)::text AS held
         FROM boop_authorization_holds
         WHERE payer_account_id=$1 AND status IN ('authorized','partially-captured')`,
        [accountId],
      );
      return balance - BigInt(held.rows[0].held);
    } finally { client.release(); }
  }

  async history(limit = 1000): Promise<LedgerTransaction[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error('limit must be between 1 and 10000');
    const result = await this.pool.query(
      `SELECT t.id,t.idempotency_key,t.kind,t.currency,t.created_at,t.metadata,t.previous_hash,t.hash,t.ledger_sequence,p.sequence,p.account_id,p.amount_minor::text
       FROM boop_ledger_transactions t JOIN boop_ledger_postings p ON p.transaction_id=t.id
       WHERE t.id IN (SELECT id FROM boop_ledger_transactions ORDER BY ledger_sequence DESC LIMIT $1)
       ORDER BY t.ledger_sequence ASC,p.sequence ASC`, [limit],
    );
    return this.rowsToTransactions(result.rows);
  }

  async verifyChain(batchSize = 1000): Promise<boolean> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw new Error('batchSize must be between 1 and 10000');
    let cursor = 0n;
    let previousHash = 'GENESIS';
    for (;;) {
      const result = await this.pool.query(
        `WITH batch AS (
           SELECT id,ledger_sequence FROM boop_ledger_transactions
           WHERE ledger_sequence > $1::bigint ORDER BY ledger_sequence ASC LIMIT $2
         )
         SELECT t.id,t.idempotency_key,t.kind,t.currency,t.created_at,t.metadata,t.previous_hash,t.hash,b.ledger_sequence,p.sequence,p.account_id,p.amount_minor::text
         FROM batch b
         JOIN boop_ledger_transactions t ON t.id=b.id
         JOIN boop_ledger_postings p ON p.transaction_id=t.id
         ORDER BY b.ledger_sequence ASC,p.sequence ASC`,
        [cursor.toString(), batchSize],
      );
      if (!result.rowCount) return true;
      const transactions = this.rowsToTransactions(result.rows);
      for (const transaction of transactions) {
        if (transaction.previousHash !== previousHash) return false;
        const { hash, ...base } = transaction;
        if (createHash('sha256').update(serialize(base)).digest('hex') !== hash) return false;
        previousHash = hash;
      }
      cursor = BigInt(result.rows[result.rows.length - 1].ledger_sequence);
      if (transactions.length < batchSize) return true;
    }
  }

  async runSerializable<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
          const result = await work(client);
          await client.query('COMMIT');
          return result;
        } catch (error: any) {
          await client.query('ROLLBACK').catch(() => undefined);
          const retryable = error?.code === '40001' || error?.code === '40P01';
          if (!retryable || attempt >= this.serializationRetries) throw error;
          await sleep(Math.min(100, 5 * 2 ** attempt) + Math.floor(Math.random() * 7));
        }
      }
    } finally { client.release(); }
  }

  async postInTransaction(client: PoolClient, input: LedgerPostInput, lockAccounts = true): Promise<LedgerTransaction> {
    this.validateInput(input);
    const existing = await this.findByIdempotencyInTransaction(client, input.idempotencyKey);
    if (existing) return existing;
    await client.query('LOCK TABLE boop_ledger_transactions IN SHARE ROW EXCLUSIVE MODE');
    const accountIds = [...new Set(input.postings.map((posting) => posting.accountId))];
    const accounts = await this.lockAccountsInTransaction(client, accountIds, lockAccounts ? 'update' : 'share');
    for (const account of accounts) if (account.currency !== input.currency) throw new Error('Cross-currency posting requires an explicit FX transaction');
    const head = await client.query('SELECT hash FROM boop_ledger_transactions ORDER BY ledger_sequence DESC LIMIT 1');
    const previousHash = head.rows[0]?.hash ?? 'GENESIS';
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const base = { id, idempotencyKey: input.idempotencyKey, kind: input.kind, currency: input.currency, postings: input.postings, createdAt, metadata: { ...input.metadata }, previousHash };
    const hash = createHash('sha256').update(serialize(base)).digest('hex');
    await client.query(
      `INSERT INTO boop_ledger_transactions (id,idempotency_key,kind,currency,created_at,metadata,previous_hash,hash) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
      [id,input.idempotencyKey,input.kind,input.currency,createdAt,JSON.stringify(input.metadata),previousHash,hash],
    );
    for (let index = 0; index < input.postings.length; index += 1) {
      const posting = input.postings[index];
      await client.query(`INSERT INTO boop_ledger_postings (transaction_id,sequence,account_id,amount_minor) VALUES ($1,$2,$3,$4::numeric)`, [id,index,posting.accountId,posting.amountMinor.toString()]);
    }
    await client.query('SELECT boop_assert_transaction_balanced($1::uuid)', [id]);
    return { ...base, hash };
  }

  async balanceInTransaction(client: PoolClient, accountId: string): Promise<bigint> {
    const result = await client.query(`SELECT COALESCE(SUM(amount_minor),0)::text AS balance FROM boop_ledger_postings WHERE account_id=$1`, [accountId]);
    return BigInt(result.rows[0].balance);
  }

  async findByIdempotencyInTransaction(client: PoolClient, key: string): Promise<LedgerTransaction | undefined> {
    const result = await client.query(
      `SELECT t.id,t.idempotency_key,t.kind,t.currency,t.created_at,t.metadata,t.previous_hash,t.hash,t.ledger_sequence,p.sequence,p.account_id,p.amount_minor::text
       FROM boop_ledger_transactions t JOIN boop_ledger_postings p ON p.transaction_id=t.id WHERE t.idempotency_key=$1 ORDER BY p.sequence`, [key],
    );
    if (!result.rowCount) return undefined;
    return this.rowsToTransactions(result.rows)[0];
  }

  async lockAccountsInTransaction(client: PoolClient, accountIds: string[], lock: 'update' | 'share'): Promise<Array<Pick<LedgerAccount,'id'|'currency'|'status'>>> {
    const unique = [...new Set(accountIds)];
    const result = await client.query(
      `SELECT id,currency,status FROM boop_ledger_accounts WHERE id = ANY($1::uuid[]) ORDER BY id ${lock === 'update' ? 'FOR UPDATE' : 'FOR SHARE'}`,
      [unique],
    );
    if (result.rowCount !== unique.length) throw new Error('One or more ledger accounts do not exist');
    const accounts = result.rows.map((row) => ({ id: row.id, currency: row.currency, status: row.status as LedgerAccount['status'] }));
    for (const account of accounts) if (account.status !== 'active') throw new Error(`Account is not active: ${account.id}`);
    return accounts;
  }

  private async requireAccountInTransaction(client: PoolClient, accountId: string): Promise<void> {
    const result = await client.query('SELECT 1 FROM boop_ledger_accounts WHERE id=$1', [accountId]);
    if (!result.rowCount) throw new Error(`Unknown account: ${accountId}`);
  }

  private validateInput(input: LedgerPostInput): void {
    if (!input.idempotencyKey.trim()) throw new Error('idempotencyKey is required');
    if (!txKinds.has(input.kind)) throw new Error('Unsupported transaction kind');
    if (input.postings.length < 2) throw new Error('A transaction requires at least two postings');
    if (input.postings.some((posting) => posting.amountMinor === 0n)) throw new Error('Zero-value postings are not allowed');
    if (input.postings.reduce((sum, posting) => sum + posting.amountMinor, 0n) !== 0n) throw new Error('Ledger transaction must balance to zero');
  }

  private rowToAccount(row: any): LedgerAccount {
    return { id: row.id, ownerId: row.owner_id, currency: row.currency, type: row.account_type, status: row.status };
  }

  private rowsToTransactions(rows: any[]): LedgerTransaction[] {
    const byId = new Map<string, LedgerTransaction>();
    for (const row of rows) {
      let tx = byId.get(row.id);
      if (!tx) {
        tx = { id: row.id, idempotencyKey: row.idempotency_key, kind: row.kind, currency: row.currency, postings: [], createdAt: new Date(row.created_at).toISOString(), metadata: row.metadata ?? {}, previousHash: row.previous_hash, hash: row.hash };
        byId.set(row.id, tx);
      }
      tx.postings.push({ accountId: row.account_id, amountMinor: BigInt(row.amount_minor) } satisfies Posting);
    }
    return [...byId.values()];
  }
}
