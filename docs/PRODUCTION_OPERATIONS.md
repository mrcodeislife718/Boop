# Boop Production Operations

## Source of financial truth

The PostgreSQL Money Kernel is authoritative for balances, postings, transaction history, and authorization holds. Application caches, analytics stores, provider dashboards, and model outputs are never authoritative balance sources.

## Database migration

Apply `migrations/001_money_kernel.sql` transactionally before serving writes. Migration failure is release failure. Never mutate historical ledger rows as part of a migration; schema evolution must preserve append-only history.

## Write isolation

Money-moving writes use `SERIALIZABLE` transactions. Transfer account rows are locked before available-balance checks. Idempotency is checked inside the same transaction. The journal head is serialized before a new hash-linked transaction is appended.

## Recovery

1. Stop or quarantine new writes when financial invariants cannot be proven.
2. Restore the latest durable database backup to an isolated recovery environment.
3. Verify the ledger chain and balanced transaction invariant.
4. Reconcile boundary accounts against external provider observations.
5. Re-enable internal transfers only after invariant and reserve checks pass.
6. Re-enable external rails independently after each rail reconciles.

Recovery must never rewrite historical transactions. Corrections use compensating entries.

## Required production metrics

- internal transfer p50/p95/p99/p100 latency
- transfers per second
- serialization retry rate
- idempotency replay rate
- invariant failures
- available database connections
- transaction lock wait time
- reconciliation lag
- unresolved reconciliation variance
- safeguarded asset coverage by currency
- reserve concentration by provider
- rail success/failure/latency/cost
- payout backlog
- cross-cell routing rate and stale-epoch rejection count

## Alert conditions

Immediate containment is required for:

- any unbalanced ledger transaction
- any negative safeguarding coverage
- hash-chain verification failure
- unexplained material reconciliation variance
- ambiguous account-cell ownership
- sustained serialization failures above the operational threshold
- external provider divergence beyond settlement windows

## Rail degradation

Rail health is independent. Quarantine of one external provider must not modify ledger history and must not automatically disable internal Boop-to-Boop transfers. Routing may fail over only when the alternative rail satisfies policy, jurisdiction, currency, amount, refund, and finality requirements.

## Scaling

At 1x, a single authoritative PostgreSQL ledger cluster is the safe baseline. At 10x, analytics/read workloads must be separated and rail/reconciliation processing partitioned. At 100x, accounts move to authoritative home cells with explicit ownership epochs. Cross-cell movement is an explicit settlement workflow; a global multi-region synchronous write transaction is not the default.

## Backup and restore proof

A release is not operationally qualified until a fresh backup has been restored into an isolated environment and the restored ledger passes chain verification, balance invariants, account-history queries, and reconciliation replay.

## Security boundary

Database credentials, provider credentials, signing material, and identity secrets must be supplied through a secrets manager or deployment environment and never committed. Production database roles should separate migration, application write, application read, and operations/audit privileges.
