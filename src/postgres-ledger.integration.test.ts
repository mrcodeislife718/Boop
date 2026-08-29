import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PostgresClosedLoopLedger } from './postgres-ledger.js';

const databaseUrl = process.env.DATABASE_URL;

test('PostgreSQL money kernel persists balanced idempotent closed-loop transfers under concurrency controls', { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  try {
    const migration = await readFile(new URL('../migrations/001_money_kernel.sql', import.meta.url), 'utf8');
    await pool.query(migration);
    await pool.query('TRUNCATE boop_reconciliation_observations, boop_authorization_holds, boop_ledger_postings, boop_ledger_transactions, boop_ledger_accounts RESTART IDENTITY CASCADE');

    const ledger = new PostgresClosedLoopLedger({ pool });
    const reserve = await ledger.createAccount('reserve', 'USD', 'asset');
    const customer = await ledger.createAccount('customer', 'USD', 'liability');
    const merchant = await ledger.createAccount('merchant', 'USD', 'liability');

    await ledger.post({
      idempotencyKey: 'fund:customer',
      kind: 'topup',
      currency: 'USD',
      postings: [
        { accountId: reserve.id, amountMinor: -100_000n },
        { accountId: customer.id, amountMinor: 100_000n },
      ],
      metadata: { source: 'integration-test' },
    });

    const first = await ledger.transfer(customer.id, merchant.id, 25_000n, 'payment:1', 'payment');
    const duplicate = await ledger.transfer(customer.id, merchant.id, 25_000n, 'payment:1', 'payment');
    assert.equal(first.id, duplicate.id);
    assert.equal(await ledger.balance(customer.id), 75_000n);
    assert.equal(await ledger.balance(merchant.id), 25_000n);
    assert.equal(await ledger.verifyChain(), true);

    const results = await Promise.allSettled([
      ledger.transfer(customer.id, merchant.id, 60_000n, 'concurrent:a', 'payment'),
      ledger.transfer(customer.id, merchant.id, 60_000n, 'concurrent:b', 'payment'),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(await ledger.balance(customer.id), 15_000n);
    assert.equal(await ledger.balance(merchant.id), 85_000n);
    assert.equal(await ledger.verifyChain(), true);
  } finally {
    await pool.end();
  }
});
