import test from 'node:test';
import assert from 'node:assert/strict';
import { ClosedLoopLedger } from './ledger.js';
import { PaymentEngine } from './payment-engine.js';
import { PaymentPolicyEngine } from './payment-policy.js';
import { PaymentOrchestrator } from './payment-orchestrator.js';
import { RailFabric } from './rail-fabric.js';

test('Boop orchestrator executes and replays an internal closed-loop payment without double movement', async () => {
  const ledger = new ClosedLoopLedger();
  const reserve = ledger.createAccount('reserve', 'USD', 'asset');
  const customer = ledger.createAccount('customer', 'USD', 'liability');
  const merchant = ledger.createAccount('merchant', 'USD', 'liability');
  ledger.post({ idempotencyKey: 'fund', kind: 'topup', currency: 'USD', postings: [{ accountId: reserve.id, amountMinor: -50_000n }, { accountId: customer.id, amountMinor: 50_000n }], metadata: {} });

  const payments = new PaymentEngine(ledger);
  const policy = new PaymentPolicyEngine({ maxSingleAmountMinor: 100_000n, maxVelocityCount24h: 100, maxVelocityAmount24hMinor: 1_000_000n, minimumPayerVerification: 'verified', minimumPayeeVerification: 'verified', maxRiskScore: 0.8 });
  const rails = new RailFabric();
  rails.register({ id: 'boop-internal', provider: 'boop', railType: 'internal', currencies: ['USD'], jurisdictions: ['US'], supportsInstantFinality: true, supportsRefunds: true, supportsIdempotency: true, estimatedCostBps: 0, fixedFeeMinor: 0n, expectedLatencyMs: 5, reliability: 1, enabled: true });
  const orchestrator = new PaymentOrchestrator(payments, policy, rails);
  const input = {
    amountMinor: 12_000n, currency: 'USD', payerAccountId: customer.id, payeeAccountId: merchant.id, jurisdiction: 'US',
    createIdempotencyKey: 'intent:1', executionIdempotencyKey: 'payment:1',
    policyContext: { payerVerification: 'verified' as const, payeeVerification: 'verified' as const, velocityCount24h: 0, velocityAmount24hMinor: 0n, accountAgeMs: 86_400_000, riskScore: 0.1, sanctionsClear: true, deviceTrusted: true },
  };
  const first = await orchestrator.execute(input);
  const replay = await orchestrator.execute(input);
  assert.equal(first.intent.id, replay.intent.id);
  assert.equal(first.intent.status, 'succeeded');
  assert.equal(ledger.balance(customer.id), 38_000n);
  assert.equal(ledger.balance(merchant.id), 12_000n);
  assert.equal(ledger.history().filter((tx) => tx.kind === 'payment').length, 1);
});
