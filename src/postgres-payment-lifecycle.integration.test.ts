import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { applyBoopMigrations } from './migrations.js';
import { PostgresClosedLoopLedger } from './postgres-ledger.js';
import { PostgresPaymentLifecycle } from './postgres-payment-lifecycle.js';

const databaseUrl = process.env.DATABASE_URL;

test('durable lifecycle supports holds, split capture, partial refund, payout and dispute without breaking ledger truth', { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    await applyBoopMigrations(pool);
    await pool.query(`TRUNCATE
      boop_payment_intent_transitions,boop_risk_decisions,boop_payment_intents,
      boop_disputes,boop_refunds,boop_authorization_captures,boop_payouts,
      boop_reconciliation_observations,boop_authorization_holds,
      boop_ledger_postings,boop_ledger_transactions,boop_ledger_accounts
      RESTART IDENTITY CASCADE`);

    const ledger = new PostgresClosedLoopLedger({ pool });
    const lifecycle = new PostgresPaymentLifecycle(ledger);
    const reserve = await ledger.createAccount('reserve', 'USD', 'asset');
    const customer = await ledger.createAccount('customer', 'USD', 'liability');
    const merchant = await ledger.createAccount('merchant', 'USD', 'liability');
    const platform = await ledger.createAccount('platform-fees', 'USD', 'revenue');
    const clearing = await ledger.createAccount('payout-clearing', 'USD', 'asset');

    await ledger.post({
      idempotencyKey: 'fund:customer:lifecycle', kind: 'topup', currency: 'USD',
      postings: [{ accountId: reserve.id, amountMinor: -100_000n }, { accountId: customer.id, amountMinor: 100_000n }], metadata: {},
    });
    await ledger.post({
      idempotencyKey: 'fund:dispute-reserve', kind: 'topup', currency: 'USD',
      postings: [{ accountId: reserve.id, amountMinor: -20_000n }, { accountId: clearing.id, amountMinor: 20_000n }], metadata: {},
    });

    const authorization = await lifecycle.authorize({
      payerAccountId: customer.id, payeeAccountId: merchant.id, amountMinor: 60_000n, currency: 'USD', idempotencyKey: 'auth:1',
    });
    const replay = await lifecycle.authorize({
      payerAccountId: customer.id, payeeAccountId: merchant.id, amountMinor: 60_000n, currency: 'USD', idempotencyKey: 'auth:1',
    });
    assert.equal(replay.id, authorization.id);
    assert.equal(await ledger.availableBalance(customer.id), 40_000n);

    const firstCapture = await lifecycle.captureWithAllocations(authorization.id, 30_000n, [
      { accountId: merchant.id, amountMinor: 28_500n, role: 'merchant' },
      { accountId: platform.id, amountMinor: 1_500n, role: 'platform-fee' },
    ], 'capture:1');
    assert.equal(firstCapture.authorization.status, 'partially-captured');
    assert.equal(firstCapture.authorization.capturedMinor, 30_000n);
    assert.equal(await ledger.availableBalance(customer.id), 40_000n);

    const secondCapture = await lifecycle.captureWithAllocations(authorization.id, 30_000n, [
      { accountId: merchant.id, amountMinor: 28_500n, role: 'merchant' },
      { accountId: platform.id, amountMinor: 1_500n, role: 'platform-fee' },
    ], 'capture:2');
    assert.equal(secondCapture.authorization.status, 'captured');
    assert.equal(await ledger.balance(customer.id), 40_000n);
    assert.equal(await ledger.balance(merchant.id), 57_000n);
    assert.equal(await ledger.balance(platform.id), 3_000n);

    const refund = await lifecycle.refund(authorization.id, 10_000n, 'refund:1', 'customer-return');
    assert.equal(refund.refundedMinor, 10_000n);
    assert.equal(await ledger.balance(customer.id), 50_000n);
    assert.equal(await ledger.balance(merchant.id), 47_000n);

    const payout = await lifecycle.createPayout({
      sourceAccountId: merchant.id, clearingAccountId: clearing.id, amountMinor: 15_000n, currency: 'USD',
      destinationReference: 'bank-token:merchant-1', railCapabilityId: 'rail:ach:primary', idempotencyKey: 'payout:1',
    });
    assert.equal(payout.status, 'processing');
    const paid = await lifecycle.recordPayoutResult(payout.id, 'succeeded', 'provider:payout:1');
    assert.equal(paid.status, 'succeeded');

    const dispute = await lifecycle.openDispute({
      authorizationId: authorization.id, disputedMinor: 5_000n, reasonCode: 'service-not-received', idempotencyKey: 'dispute:1', provisionalSourceAccountId: clearing.id,
    });
    assert.equal(dispute.status, 'opened');
    assert.equal(await ledger.balance(customer.id), 55_000n);
    const resolved = await lifecycle.resolveDispute(dispute.id, 'lost', 'dispute:resolve:1', clearing.id);
    assert.equal(resolved.status, 'lost');

    assert.equal(await ledger.verifyChain(2), true);
  } finally {
    await pool.end();
  }
});
