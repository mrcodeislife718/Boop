import { createHash, randomUUID } from 'node:crypto';

export type AccountType = 'asset' | 'liability' | 'revenue' | 'expense' | 'equity';
export type LedgerAccount = { id: string; ownerId: string; currency: string; type: AccountType; status: 'active' | 'frozen' | 'closed' };
export type Posting = { accountId: string; amountMinor: bigint };
export type LedgerTransaction = {
  id: string;
  idempotencyKey: string;
  kind: 'topup' | 'transfer' | 'payment' | 'refund' | 'payout' | 'adjustment';
  currency: string;
  postings: Posting[];
  createdAt: string;
  metadata: Record<string, string>;
  previousHash: string;
  hash: string;
};

const sum = (postings: Posting[]) => postings.reduce((total, posting) => total + posting.amountMinor, 0n);

export class ClosedLoopLedger {
  private readonly accounts = new Map<string, LedgerAccount>();
  private readonly transactions: LedgerTransaction[] = [];
  private readonly idempotency = new Map<string, LedgerTransaction>();

  createAccount(ownerId: string, currency: string, type: AccountType = 'liability'): LedgerAccount {
    if (!ownerId.trim()) throw new Error('ownerId is required');
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('currency must be an ISO-style uppercase code');
    const account: LedgerAccount = { id: randomUUID(), ownerId, currency, type, status: 'active' };
    this.accounts.set(account.id, account);
    return account;
  }

  post(input: Omit<LedgerTransaction, 'id' | 'createdAt' | 'previousHash' | 'hash'>): LedgerTransaction {
    const prior = this.idempotency.get(input.idempotencyKey);
    if (prior) return prior;
    if (!input.postings.length || input.postings.length < 2) throw new Error('A transaction requires at least two postings');
    if (sum(input.postings) !== 0n) throw new Error('Ledger transaction must balance to zero');

    for (const posting of input.postings) {
      if (posting.amountMinor === 0n) throw new Error('Zero-value postings are not allowed');
      const account = this.accounts.get(posting.accountId);
      if (!account) throw new Error(`Unknown account: ${posting.accountId}`);
      if (account.status !== 'active') throw new Error(`Account is not active: ${posting.accountId}`);
      if (account.currency !== input.currency) throw new Error('Cross-currency posting requires an explicit FX transaction');
    }

    const previousHash = this.transactions.at(-1)?.hash ?? 'GENESIS';
    const base = {
      id: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      kind: input.kind,
      currency: input.currency,
      postings: input.postings,
      createdAt: new Date().toISOString(),
      metadata: { ...input.metadata },
      previousHash,
    };
    const hash = createHash('sha256').update(JSON.stringify(base, (_, value) => typeof value === 'bigint' ? value.toString() : value)).digest('hex');
    const transaction: LedgerTransaction = { ...base, hash };
    this.transactions.push(transaction);
    this.idempotency.set(input.idempotencyKey, transaction);
    return transaction;
  }

  transfer(fromAccountId: string, toAccountId: string, amountMinor: bigint, idempotencyKey: string, kind: LedgerTransaction['kind'] = 'transfer'): LedgerTransaction {
    if (amountMinor <= 0n) throw new Error('amountMinor must be positive');
    const from = this.requireAccount(fromAccountId);
    const to = this.requireAccount(toAccountId);
    if (from.currency !== to.currency) throw new Error('Closed-loop transfer accounts must use the same currency');
    if (this.availableBalance(fromAccountId) < amountMinor) throw new Error('Insufficient balance');
    return this.post({
      idempotencyKey,
      kind,
      currency: from.currency,
      postings: [
        { accountId: fromAccountId, amountMinor: -amountMinor },
        { accountId: toAccountId, amountMinor },
      ],
      metadata: {},
    });
  }

  balance(accountId: string): bigint {
    this.requireAccount(accountId);
    return this.transactions.reduce((total, transaction) => total + transaction.postings.filter((p) => p.accountId === accountId).reduce((s, p) => s + p.amountMinor, 0n), 0n);
  }

  availableBalance(accountId: string): bigint {
    return this.balance(accountId);
  }

  verifyChain(): boolean {
    let previousHash = 'GENESIS';
    for (const transaction of this.transactions) {
      if (transaction.previousHash !== previousHash) return false;
      const { hash, ...base } = transaction;
      const expected = createHash('sha256').update(JSON.stringify(base, (_, value) => typeof value === 'bigint' ? value.toString() : value)).digest('hex');
      if (expected !== hash) return false;
      previousHash = hash;
    }
    return true;
  }

  history(): readonly LedgerTransaction[] {
    return this.transactions.map((transaction) => ({ ...transaction, postings: transaction.postings.map((posting) => ({ ...posting })), metadata: { ...transaction.metadata } }));
  }

  private requireAccount(id: string): LedgerAccount {
    const account = this.accounts.get(id);
    if (!account) throw new Error(`Unknown account: ${id}`);
    return account;
  }
}
