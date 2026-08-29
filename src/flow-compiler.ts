import type { Posting } from './ledger.js';

export type FlowAccount = {
  id: string;
  currency: string;
  writable: boolean;
  availableMinor: bigint;
  limitMinor?: bigint;
};

export type FlowAllocation = {
  accountId: string;
  amountMinor: bigint;
};

export type FlowContract = {
  id: string;
  currency: string;
  sources: FlowAllocation[];
  destinations: FlowAllocation[];
  metadata?: Record<string, string>;
};

export type CompiledFlow = {
  contractId: string;
  currency: string;
  postings: Posting[];
  totalMinor: bigint;
  metadata: Record<string, string>;
};

export class FinancialFlowCompiler {
  compile(contract: FlowContract, accounts: FlowAccount[]): CompiledFlow {
    if (!contract.id.trim()) throw new Error('Flow contract id is required');
    if (!/^[A-Z]{3}$/.test(contract.currency)) throw new Error('Flow currency must be an uppercase ISO-style code');
    if (!contract.sources.length || !contract.destinations.length) throw new Error('Flow requires sources and destinations');

    const accountMap = new Map(accounts.map((account) => [account.id, account]));
    if (accountMap.size !== accounts.length) throw new Error('Duplicate account definitions are not allowed');

    const sourceTotal = contract.sources.reduce((sum, item) => sum + item.amountMinor, 0n);
    const destinationTotal = contract.destinations.reduce((sum, item) => sum + item.amountMinor, 0n);
    if (sourceTotal <= 0n || destinationTotal <= 0n) throw new Error('Flow amounts must be positive');
    if (sourceTotal !== destinationTotal) throw new Error('Flow sources and destinations must balance');

    const aggregateSource = new Map<string, bigint>();
    const aggregateDestination = new Map<string, bigint>();
    for (const allocation of contract.sources) {
      if (allocation.amountMinor <= 0n) throw new Error('Source allocations must be positive');
      aggregateSource.set(allocation.accountId, (aggregateSource.get(allocation.accountId) ?? 0n) + allocation.amountMinor);
    }
    for (const allocation of contract.destinations) {
      if (allocation.amountMinor <= 0n) throw new Error('Destination allocations must be positive');
      aggregateDestination.set(allocation.accountId, (aggregateDestination.get(allocation.accountId) ?? 0n) + allocation.amountMinor);
    }

    for (const [accountId, amountMinor] of aggregateSource) {
      const account = this.requireAccount(accountMap, accountId, contract.currency);
      if (!account.writable) throw new Error(`Source account is not writable: ${accountId}`);
      if (account.availableMinor < amountMinor) throw new Error(`Insufficient available balance: ${accountId}`);
      if (account.limitMinor !== undefined && amountMinor > account.limitMinor) throw new Error(`Flow exceeds account limit: ${accountId}`);
    }
    for (const [accountId, amountMinor] of aggregateDestination) {
      const account = this.requireAccount(accountMap, accountId, contract.currency);
      if (!account.writable) throw new Error(`Destination account is not writable: ${accountId}`);
      if (account.limitMinor !== undefined && amountMinor > account.limitMinor) throw new Error(`Flow exceeds account limit: ${accountId}`);
    }

    const net = new Map<string, bigint>();
    for (const [accountId, amountMinor] of aggregateSource) net.set(accountId, (net.get(accountId) ?? 0n) - amountMinor);
    for (const [accountId, amountMinor] of aggregateDestination) net.set(accountId, (net.get(accountId) ?? 0n) + amountMinor);
    const postings: Posting[] = [...net.entries()]
      .filter(([, amountMinor]) => amountMinor !== 0n)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([accountId, amountMinor]) => ({ accountId, amountMinor }));
    if (postings.reduce((sum, posting) => sum + posting.amountMinor, 0n) !== 0n) throw new Error('Compiled flow invariant violation');

    return {
      contractId: contract.id,
      currency: contract.currency,
      postings,
      totalMinor: sourceTotal,
      metadata: { ...(contract.metadata ?? {}) },
    };
  }

  private requireAccount(map: Map<string, FlowAccount>, id: string, currency: string): FlowAccount {
    const account = map.get(id);
    if (!account) throw new Error(`Unknown flow account: ${id}`);
    if (account.currency !== currency) throw new Error(`Currency mismatch for account: ${id}`);
    return account;
  }
}
