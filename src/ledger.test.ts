import assert from 'node:assert/strict';
import test from 'node:test';
import { ClosedLoopLedger } from './ledger.js';
import { PaymentEngine } from './payment-engine.js';

function fundedLedger() {
  const ledger = new ClosedLoopLedger();
  const reserve = ledger.createAccount('boop-reserve', 'USD', 'asset');
  const consumer = ledger.createAccount('consumer-1', 'USD');
  const merchant = ledger.createAccount('merchant-1', 'USD');
  ledger.post({
    idempotencyKey: 'seed-consumer',
    kind: 'topup',
    currency: 'USD',
    postings: [
      { accountId: reserve.id, amountMinor: -10_000n },
      { accountId: consumer.id, amountMinor: 10_000n },
    ],
    metadata: { source: 'test-reserve' },
  });
  return { ledger, reserve, consumer, merchant };
}

test('closed-loop payment moves value without leaving the ledger and preserves balance', () => {
  const { ledger, consumer, merchant } = fundedLedger();
  const payment = new PaymentEngine(ledger);
  const auth = payment.authorize(consumer.id, merchant.id, 2_500n, 'USD');
  assert.equal(payment.available(consumer.id), 7_500n);
  payment.capture(auth.id, 'capture-1');
  assert.equal(ledger.balance(consumer.id), 7_500n);
  assert.equal(ledger.balance(merchant.id), 2_500n);
  assert.equal(ledger.verifyChain(), true);
});

test('capture is idempotent and refund reverses value', () => {
  const { ledger, consumer, merchant } = fundedLedger();
  const payment = new PaymentEngine(ledger);
  const auth = payment.authorize(consumer.id, merchant.id, 1_000n, 'USD');
  const first = payment.capture(auth.id, 'capture-idempotent');
  const second = payment.capture(auth.id, 'capture-idempotent');
  assert.equal(first.id, second.id);
  payment.refund(auth.id, 'refund-1');
  assert.equal(ledger.balance(consumer.id), 10_000n);
  assert.equal(ledger.balance(merchant.id), 0n);
});
