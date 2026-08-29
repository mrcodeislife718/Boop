# Boop Closed-Loop Network

Boop is a closed-loop stored-value and payment network, not merely a payment-processor wrapper.

```text
external funding rail
  -> Boop reserve / settlement boundary
  -> Boop Account + Wallet
  -> internal Boop ledger transfer
  -> merchant / worker / platform Boop balance
  -> optional external payout rail
```

When both sides of a transaction are Boop participants and policy permits internal settlement, the authoritative value movement occurs on Boop's own ledger. Banks, cards, RTP/FedNow-compatible providers, and other regulated partners are boundary rails for funding, withdrawal, external settlement, or jurisdiction-specific obligations.

## Implemented core

`src/ledger.ts` implements the initial append-only double-entry ledger. Every transaction requires balanced postings, an idempotency key, same-currency accounts, active account state, an immutable transaction identity, and a hash linked to the preceding transaction.

`src/payment-engine.ts` implements authorization holds, available-balance calculation, capture, release, and full refund. Captures and refunds become ordinary balanced ledger transactions rather than mutable payment records.

## Financial invariants

1. Every ledger transaction balances to zero.
2. A consequential request is idempotent.
3. Financial history is append-only; corrections are compensating transactions.
4. Currency conversion must be explicit rather than hidden inside a posting.
5. Holds reduce spendable balance before capture.
6. Capture converts an authorization into ledger movement.
7. Refund reverses value through a new transaction.
8. The ledger can verify its transaction hash chain.

## Required next layers

Production Boop still requires durable database persistence; ACID transaction isolation; multi-ledger reconciliation; reserve and safeguarding accounting; partial capture/refund; disputes and chargebacks; fees and allocation postings; settlement batches; payout state machines; KYC/KYB and sanctions/risk integrations; limits and velocity controls; device/session assurance; merchant and platform hierarchies; cryptographic signing; audit exports; operational tooling; regulatory partner adapters; and disaster recovery.
