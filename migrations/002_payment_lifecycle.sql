BEGIN;

ALTER TABLE boop_authorization_holds ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS boop_authorization_idempotency_idx ON boop_authorization_holds(idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE boop_disputes ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS boop_dispute_idempotency_idx ON boop_disputes(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS boop_payment_intents (
  id uuid PRIMARY KEY,
  create_idempotency_key text NOT NULL UNIQUE,
  amount_minor numeric(78,0) NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  payer_account_id uuid NOT NULL REFERENCES boop_ledger_accounts(id) ON DELETE RESTRICT,
  payee_account_id uuid NOT NULL REFERENCES boop_ledger_accounts(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('requires-authorization','authorized','processing','succeeded','cancelled','failed','partially-refunded','refunded')),
  authorization_id uuid REFERENCES boop_authorization_holds(id) ON DELETE RESTRICT,
  route_id text,
  external_reference text,
  captured_minor numeric(78,0) NOT NULL DEFAULT 0 CHECK (captured_minor >= 0 AND captured_minor <= amount_minor),
  refunded_minor numeric(78,0) NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0 AND refunded_minor <= captured_minor),
  failure_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS boop_payment_intents_status_idx ON boop_payment_intents(status, updated_at);
CREATE INDEX IF NOT EXISTS boop_payment_intents_payer_idx ON boop_payment_intents(payer_account_id, created_at);
CREATE INDEX IF NOT EXISTS boop_payment_intents_payee_idx ON boop_payment_intents(payee_account_id, created_at);

CREATE SEQUENCE IF NOT EXISTS boop_payment_transition_sequence;
CREATE TABLE IF NOT EXISTS boop_payment_intent_transitions (
  sequence bigint PRIMARY KEY DEFAULT nextval('boop_payment_transition_sequence'),
  intent_id uuid NOT NULL REFERENCES boop_payment_intents(id) ON DELETE RESTRICT,
  from_status text NOT NULL,
  to_status text NOT NULL,
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS boop_payment_transitions_intent_idx ON boop_payment_intent_transitions(intent_id, sequence);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='boop_risk_decisions_payment_intent_fk'
  ) THEN
    ALTER TABLE boop_risk_decisions
      ADD CONSTRAINT boop_risk_decisions_payment_intent_fk
      FOREIGN KEY (payment_intent_id) REFERENCES boop_payment_intents(id) ON DELETE RESTRICT;
  END IF;
END $$;

COMMIT;
