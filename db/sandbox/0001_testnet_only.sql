-- Sandbox databases only. Apply after db/migrations/0001_checkout_orders.sql to a disposable database
-- used for the CipherPay testnet check, never to a customer or production database:
--   psql "$SANDBOX_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f db/migrations/0001_checkout_orders.sql
--   psql "$SANDBOX_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f db/sandbox/0001_testnet_only.sql
--
-- Replaces the mainnet-only invoice address check with a testnet-only one. A database prepared this
-- way cannot record a mainnet `u1` invoice, and a production database cannot record a testnet one, so
-- the two can never be mixed up. The sandbox preflight refuses a database without this constraint.
ALTER TABLE checkout_invoices DROP CONSTRAINT checkout_invoices_payment_address_check;
ALTER TABLE checkout_invoices ADD CONSTRAINT checkout_invoices_payment_address_testnet_only
  CHECK (payment_address ~ '^utest1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$' AND length(payment_address) BETWEEN 66 AND 1006);
