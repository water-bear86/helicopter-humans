-- 49TH-20: durable order / invoice / receipt store for the CipherPay invoice checkout.
-- Apply once, in a transaction, to an isolated database approved for this app:
--   psql "$CHECKOUT_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f db/migrations/0001_checkout_orders.sql
-- Re-running fails on the checkout_schema_migrations primary key and changes nothing.
-- No secrets are stored: the buyer credential is a SHA-256 digest of a 256-bit random code.

CREATE TABLE checkout_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO checkout_schema_migrations (version) VALUES ('0001_checkout_orders');

CREATE TABLE checkout_orders (
  id uuid PRIMARY KEY,
  credential_hash char(64) NOT NULL UNIQUE CHECK (credential_hash ~ '^[0-9a-f]{64}$'),
  offer_id text NOT NULL CHECK (length(offer_id) BETWEEN 1 AND 64),
  offer_version text NOT NULL CHECK (length(offer_version) BETWEEN 1 AND 64),
  fiat_currency char(3) NOT NULL CHECK (fiat_currency = 'USD'),
  fiat_amount_cents integer NOT NULL CHECK (fiat_amount_cents > 0),
  state text NOT NULL CHECK (state IN (
    'new', 'creating_invoice', 'quote_unverified', 'awaiting_payment', 'payment_detected', 'fulfilled',
    'expired', 'quote_rejected', 'needs_resolution', 'reconciliation_required', 'quarantined', 'cancelled', 'refunded'
  )),
  state_reason text CHECK (length(state_reason) <= 200),
  active_invoice_id text,
  quote_count integer NOT NULL DEFAULT 0 CHECK (quote_count BETWEEN 0 AND 10),
  claim_token uuid,
  claim_expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- A creation claim is all-or-nothing and exists only while creating.
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)),
  CHECK ((state = 'creating_invoice') = (claim_token IS NOT NULL))
);

CREATE TABLE checkout_invoices (
  -- Unique invoice binding: one provider invoice belongs to exactly one order.
  provider_invoice_id text PRIMARY KEY CHECK (provider_invoice_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  order_id uuid NOT NULL REFERENCES checkout_orders (id),
  memo_code text NOT NULL CHECK (memo_code ~ '^CP-[0-9A-F]{8}$'),
  -- Exact per-invoice address as returned by the provider. Never shared between invoices.
  payment_address text NOT NULL UNIQUE CHECK (payment_address ~ '^u1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$' AND length(payment_address) BETWEEN 62 AND 1002),
  -- Provider float, audit only. Payable amounts use price_zatoshis.
  price_zec double precision NOT NULL CHECK (price_zec > 0),
  price_zatoshis bigint CHECK (price_zatoshis > 0 AND price_zatoshis <= 9007199254740991),
  payment_uri text CHECK (length(payment_uri) <= 2048),
  expires_at timestamptz NOT NULL,
  provider_status text NOT NULL CHECK (length(provider_status) <= 32),
  received_zatoshis bigint NOT NULL DEFAULT 0 CHECK (received_zatoshis >= 0 AND received_zatoshis <= 9007199254740991),
  rejected_reason text CHECK (length(rejected_reason) <= 200),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- A payable URI only ever exists alongside the validated integer amount.
  CHECK (payment_uri IS NULL OR price_zatoshis IS NOT NULL)
);
CREATE INDEX checkout_invoices_order_idx ON checkout_invoices (order_id);

ALTER TABLE checkout_orders
  ADD CONSTRAINT checkout_orders_active_invoice_fk FOREIGN KEY (active_invoice_id) REFERENCES checkout_invoices (provider_invoice_id)
  DEFERRABLE INITIALLY DEFERRED;

-- Every txid we have seen, and the one order it counts for. A second order reporting the same txid
-- is quarantined instead of granted.
CREATE TABLE checkout_payment_txids (
  txid char(64) PRIMARY KEY CHECK (txid ~ '^[0-9a-f]{64}$'),
  order_id uuid NOT NULL REFERENCES checkout_orders (id),
  provider_invoice_id text NOT NULL REFERENCES checkout_invoices (provider_invoice_id),
  first_seen_at timestamptz NOT NULL
);

-- The preorder entitlement. At most one per order and one per invoice, whatever retries do.
CREATE TABLE checkout_receipts (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES checkout_orders (id),
  provider_invoice_id text NOT NULL UNIQUE REFERENCES checkout_invoices (provider_invoice_id),
  offer_id text NOT NULL,
  offer_version text NOT NULL,
  fiat_amount_cents integer NOT NULL CHECK (fiat_amount_cents > 0),
  price_zatoshis bigint NOT NULL CHECK (price_zatoshis > 0),
  received_zatoshis bigint NOT NULL CHECK (received_zatoshis >= price_zatoshis),
  created_at timestamptz NOT NULL,
  revoked_at timestamptz
);

-- Refunds are manual. This records the buyer's authenticated request and shielded return address.
CREATE TABLE checkout_refund_requests (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES checkout_orders (id),
  refund_address text NOT NULL CHECK (length(refund_address) BETWEEN 78 AND 1024),
  received_zatoshis bigint NOT NULL CHECK (received_zatoshis > 0),
  created_at timestamptz NOT NULL
);
