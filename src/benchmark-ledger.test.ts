import test from 'node:test';
import assert from 'node:assert/strict';
import { FinancialBenchmarkLedger } from './benchmark-ledger.js';

test('financial benchmark reports tail latency and failures from recorded operations', () => {
  const ledger = new FinancialBenchmarkLedger();
  ledger.record({ id: '1', operation: 'internal-transfer', startedAt: '2026-08-29T14:00:00Z', durationMs: 2, success: true });
  ledger.record({ id: '2', operation: 'internal-transfer', startedAt: '2026-08-29T14:00:01Z', durationMs: 4, success: true });
  ledger.record({ id: '3', operation: 'internal-transfer', startedAt: '2026-08-29T14:00:02Z', durationMs: 12, success: false, errorCode: 'SerializationFailure' });
  const summary = ledger.summarize('internal-transfer');
  assert.equal(summary.samples, 3);
  assert.equal(summary.p100Ms, 12);
  assert.equal(summary.errorCounts.SerializationFailure, 1);
  assert.equal(summary.successRate, 2 / 3);
});
