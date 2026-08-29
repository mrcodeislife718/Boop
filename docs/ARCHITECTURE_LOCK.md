# Boop Architecture Lock

Status: **LOCKED**

## Technical moat

Boop is a financial network whose authoritative center is a deterministic closed-loop money kernel. Internal value movement is local, correct, low-latency, and independent of external processors; banks and payment networks are interchangeable boundary rails.

## Permanent plane separation

1. Intelligence plane — routing, risk, optimization, and fraud models advise.
2. Decision plane — policy, identity, limits, and payment-intent state determine authorized actions.
3. Truth plane — the Money Kernel ledger determines balances and financial history.
4. Execution plane — internal ledger transfer or selected external rail executes movement.
5. Observation plane — provider events, settlement files, reserve positions, and reconciliation results update operational state without rewriting ledger history.

No model or external provider may directly rewrite ledger truth.

## Locked architecture

PAYMENT INTENT -> POLICY / RISK / IDENTITY -> BOOP MONEY KERNEL (ledger + holds + limits) -> EVENT JOURNAL -> CONTINUOUS RECONCILIATION -> INTERNAL ROUTE or RAIL VIRTUALIZATION -> settlement observation.

### Money Kernel

The kernel contains accounts, integer amounts, currencies, transfers, holds, limits, idempotency, strict invariants, immutable journal references, and no unrelated business metadata.

### Rail Virtualization

A canonical payment lifecycle routes across internal transfer, ACH, card, RTP, FedNow-compatible providers, bank transfers, or future rails based on capability, cost, latency, reliability, risk, customer/merchant preference, and jurisdiction.

### Continuous Financial Invariant Engine

Boop continuously compares internal boundary accounts, safeguarded/reserve assets, provider balances, settlement expectations, and observed settlement. Drift is quarantined rather than silently absorbed.

### Financial Flow Compiler

Declarative flow contracts compile into balanced atomic postings only after proving source/destination balance, currency consistency, permissions, limits, and funding.

### Cell Scale Architecture

Accounts have one authoritative home cell. Cross-cell transfers are explicit settlement operations. Ownership epochs prevent split-brain routing.

## Scaling doctrine

- 1x: one authoritative ledger cluster.
- 10x: separated reads/analytics, asynchronous rail workers, partitioned reconciliation.
- 100x: account-owned regional/enterprise ledger cells and federated settlement.

## Success-too-well control

As stored value grows, safeguarding, reserve concentration, liquidity, operational resilience, and withdrawal capacity are first-class system constraints. Growth MUST NOT outrun reconciled safeguarded assets or tested payout capacity.

## Permanent benchmark

Primary metrics: zero invariant violations under fault injection, service-side internal-transfer p99 latency, sustainable transfers/second, recovery point/time, reconciliation lag, and rail failover success.