BEGIN;

CREATE TABLE IF NOT EXISTS boop_ledger_accounts (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  account_type text NOT NULL CHECK (account_type IN ('asset','liability','revenue','expense','equity')),
  status text NOT NULL CHECK (status IN ('active','frozen','closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS boop_ledger_sequence;

CREATE TABLE IF NOT EXISTS boop_ledger_transactions (
  id uuid PRIMARY KEY,
  ledger_sequence bigint NOT NULL DEFAULT nextval('boop_ledger_sequence'),
  idempotency_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('topup','transfer','payment','refund','payout','adjustment')),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_hash text NOT NULL,
  hash text NOT NULL UNIQUE
);

ALTER TABLE boop_ledger_transactions ADD COLUMN IF NOT EXISTS ledger_sequence bigint;
ALTER TABLE boop_ledger_transactions ALTER COLUMN ledger_sequence SET DEFAULT nextval('boop_ledger_sequence');
UPDATE boop_ledger_transactions SET ledger_sequence = nextval('boop_ledger_sequence') WHERE ledger_sequence IS NULL;
ALTER TABLE boop_ledger_transactions ALTER COLUMN ledger_sequence SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS boop_transactions_sequence_idx ON boop_ledger_transactions(ledger_sequence);

CREATE TABLE IF NOT EXISTS boop_ledger_postings (
  transaction_id uuid NOT NULL REFERENCES boop_ledger_transactions(id) ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK (sequence >= 0),
  account_id uuid NOT NULL REFERENCES boop_ledger_accounts(id) ON DELETE RESTRICT,
  amount_minor numeric(78,0) NOT NULL CHECK (amount_minor <> 0),
  PRIMARY KEY (transaction_id, sequence)
);

CREATE INDEX IF NOT EXISTS boop_postings_account_idx ON boop_ledger_postings(account_id, transaction_id);
CREATE INDEX IF NOT EXISTS boop_transactions_created_idx ON boop_ledger_transactions(created_at, id);

CREATE OR REPLACE FUNCTION boop_assert_transaction_balanced(p_transaction_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_sum numeric(78,0);
  v_count integer;
BEGIN
  SELECT COALESCE(SUM(amount_minor), 0), COUNT(*) INTO v_sum, v_count
  FROM boop_ledger_postings
  WHERE transaction_id = p_transaction_id;

  IF v_count < 2 THEN
    RAISE EXCEPTION 'transaction % requires at least two postings', p_transaction_id;
  END IF;
  IF v_sum <> 0 THEN
    RAISE EXCEPTION 'transaction % is not balanced: %', p_transaction_id, v_sum;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS boop_authorization_holds (
  id uuid PRIMARY KEY,
  payer_account_id uuid NOT NULL REFERENCES boop_ledger_accounts(id) ON DELETE RESTRICT,
  payee_account_id uuid NOT NULL REFERENCES boop_ledger_accounts(id) ON DELETE RESTRICT,
  amount_minor numeric(78,0) NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  status text NOT NULL CHECK (status IN ('authorized','captured','released','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  capture_transaction_id uuid REFERENCES boop_ledger_transactions(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS boop_holds_payer_status_idx ON boop_authorization_holds(payer_account_id, status);

CREATE TABLE IF NOT EXISTS boop_reconciliation_observations (
  id text PRIMARY KEY,
  boundary_account_id text NOT NULL,
  provider text NOT NULL,
  currency char(3) NOT NULL,
  expected_minor numeric(78,0) NOT NULL,
  observed_minor numeric(78,0) NOT NULL,
  variance_minor numeric(78,0) NOT NULL,
  status text NOT NULL CHECK (status IN ('matched','pending-window','quarantined','resolved')),
  observed_at timestamptz NOT NULL,
  detected_at timestamptz NOT NULL,
  settlement_reference text,
  resolution_reference text,
  resolved_at timestamptz
);

COMMIT;
