# Boop Evidence and Benchmark Plan

## Primary superiority claims

1. Financial invariants survive retries, crashes, reordering, and concurrency.
2. Internal closed-loop transfers achieve predictable low tail latency.
3. External rails are replaceable without changing customer payment semantics.
4. Reconciliation detects financial drift continuously.
5. Declarative flow compilation prevents invalid money movement before execution.

## Required measurements

- p50/p95/p99/p100 internal transfer latency
- sustained transfers/second and batch size
- duplicate-request rate and duplicate-effect rate
- invariant violation count
- crash recovery time and recovery point
- reconciliation lag and unresolved variance
- rail failover success rate
- route cost and success rate by rail
- cross-cell vs local latency
- flow compiler rejection and false-rejection rate

## Validation experiments

### Fault campaign
Inject duplicate commands, process crashes, reordered events, partial external failures, timeouts, and concurrent transfers; prove balances and journal invariants remain correct.

### Latency/throughput benchmark
Run reproducible single-transfer and batched-transfer workloads with percentile latency and CPU/memory reporting.

### Rail continuity
Disable one rail/provider at a time and verify canonical payment state remains valid while routing falls back when policy permits.

### Reconciliation corruption test
Drop, duplicate, delay, and reorder provider/settlement observations and measure time to detection and containment.

### Flow property testing
Generate large valid and invalid flow graphs; every accepted graph must balance and satisfy currency, permission, limit, and funding rules.

### Cell failover
Simulate region loss, home-cell migration, stale ownership epochs, and cross-cell settlement interruption.

## Failure policy

Any unexplained ledger/reserve variance quarantines affected movement. Any uncertain account-cell ownership rejects writes. If optimized rail selection degrades success or correctness, routing falls back to deterministic policy.