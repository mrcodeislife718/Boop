import test from 'node:test';
import assert from 'node:assert/strict';
import { PaymentIntentStore } from './payment-intent.js';
import { RailFabric } from './rail-fabric.js';
import { ContinuousReconciliationEngine } from './reconciliation.js';
import { FinancialFlowCompiler } from './flow-compiler.js';
import { LedgerCellRouter } from './cell-router.js';
import { SafeguardingEngine } from './safeguarding.js';

test('payment intent enforces canonical lifecycle and idempotent creation', () => {
  const store = new PaymentIntentStore();
  const input = { amountMinor: 10_000n, currency: 'USD', payerAccountId: 'payer', payeeAccountId: 'merchant', metadata: {} };
  const first = store.create(input, 'create:1');
  const duplicate = store.create(input, 'create:1');
  assert.equal(first.id, duplicate.id);
  store.transition(first.id, 'authorized', 'funds authorized', { authorizationId: 'auth:1' });
  const succeeded = store.transition(first.id, 'succeeded', 'internal capture complete', { capturedMinor: 10_000n, routeId: 'internal' });
  assert.equal(succeeded.status, 'succeeded');
  assert.throws(() => store.transition(first.id, 'cancelled', 'invalid late cancellation'));
});

test('rail fabric chooses eligible rail and can fail over when provider is disabled', () => {
  const fabric = new RailFabric();
  fabric.register({ id: 'internal', provider: 'boop', railType: 'internal', currencies: ['USD'], jurisdictions: ['*'], supportsInstantFinality: true, supportsRefunds: true, supportsIdempotency: true, estimatedCostBps: 0, fixedFeeMinor: 0n, expectedLatencyMs: 5, reliability: 0.99999, enabled: true });
  fabric.register({ id: 'instant-backup', provider: 'provider-b', railType: 'rtp', currencies: ['USD'], jurisdictions: ['US'], supportsInstantFinality: true, supportsRefunds: false, supportsIdempotency: true, estimatedCostBps: 1, fixedFeeMinor: 10n, expectedLatencyMs: 500, reliability: 0.999, enabled: true });
  const request = { amountMinor: 5_000n, currency: 'USD', jurisdiction: 'US', requireInstant: true };
  assert.equal(fabric.choose(request).capabilityId, 'internal');
  fabric.setEnabled('internal', false);
  assert.equal(fabric.choose(request).capabilityId, 'instant-backup');
});

test('reconciliation quarantines unexplained material variance', () => {
  const engine = new ContinuousReconciliationEngine({ toleranceMinor: 1n, settlementWindowMs: 1000, quarantineThresholdMinor: 100n });
  const variance = engine.observe({ id: 'obs:1', boundaryAccountId: 'boundary:1', provider: 'provider', currency: 'USD', expectedMinor: 1000n, observedMinor: 800n, observedAt: '2026-08-29T10:00:00Z' }, Date.parse('2026-08-29T10:00:00Z'));
  assert.equal(variance.status, 'quarantined');
  assert.throws(() => engine.assertProviderHealthy('provider'));
  engine.resolve('obs:1', 'case:resolved');
  assert.doesNotThrow(() => engine.assertProviderHealthy('provider'));
});

test('flow compiler proves balance, currency, funds, and limits before execution', () => {
  const compiler = new FinancialFlowCompiler();
  const compiled = compiler.compile({
    id: 'marketplace-sale', currency: 'USD',
    sources: [{ accountId: 'customer', amountMinor: 10_000n }],
    destinations: [
      { accountId: 'merchant', amountMinor: 9_000n },
      { accountId: 'courier', amountMinor: 500n },
      { accountId: 'platform', amountMinor: 300n },
      { accountId: 'tax', amountMinor: 200n },
    ],
  }, [
    { id: 'customer', currency: 'USD', writable: true, availableMinor: 20_000n },
    { id: 'merchant', currency: 'USD', writable: true, availableMinor: 0n },
    { id: 'courier', currency: 'USD', writable: true, availableMinor: 0n },
    { id: 'platform', currency: 'USD', writable: true, availableMinor: 0n },
    { id: 'tax', currency: 'USD', writable: true, availableMinor: 0n },
  ]);
  assert.equal(compiled.totalMinor, 10_000n);
  assert.equal(compiled.postings.reduce((sum, posting) => sum + posting.amountMinor, 0n), 0n);
});

test('cell router rejects stale ownership epochs and marks cross-cell movement explicitly', () => {
  const router = new LedgerCellRouter();
  router.registerCell({ id: 'east', region: 'us-east', status: 'active', writeEndpoint: 'https://east.invalid' });
  router.registerCell({ id: 'west', region: 'us-west', status: 'active', writeEndpoint: 'https://west.invalid' });
  const source = router.assign('account:a', 'east');
  const destination = router.assign('account:b', 'west');
  assert.equal(router.route('account:a', 'account:b', source.epoch, destination.epoch).kind, 'cross-cell');
  const migrated = router.migrate('account:a', 'west', source.epoch);
  assert.equal(router.route('account:a', 'account:b', migrated.epoch, destination.epoch).kind, 'local');
  assert.throws(() => router.route('account:a', 'account:b', source.epoch, destination.epoch));
});

test('safeguarding engine prevents liabilities from outrunning available safeguarded assets', () => {
  const engine = new SafeguardingEngine();
  engine.recordAsset({ id: 'reserve:1', provider: 'bank-a', currency: 'USD', amountMinor: 100_000n, observedAt: new Date().toISOString(), accountReference: 'bank-account-a', status: 'available' });
  const state = engine.evaluate({ currency: 'USD', customerLiabilityMinor: 80_000n, pendingWithdrawalMinor: 10_000n });
  assert.equal(state.healthy, true);
  assert.equal(state.surplusMinor, 10_000n);
  assert.throws(() => engine.assertCanIncreaseLiability({ currency: 'USD', customerLiabilityMinor: 80_000n, pendingWithdrawalMinor: 10_000n }, 20_000n));
});
