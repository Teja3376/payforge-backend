-- Double-entry accounting: add the counterparty accounts.
--
-- The journal previously only had MERCHANT and PLATFORM, so every movement
-- posted legs that could not offset each other:
--
--   * Settlement wrote two CREDIT rows (merchant net, platform fee) with no
--     payer side. Sum(debits) was permanently 0 against non-zero credits.
--   * Payouts wrote a single unpaired DEBIT, so money left the merchant's
--     ledger and appeared nowhere else.
--
-- MERCHANT_CLEARING is the counterparty for funds the platform holds on a
-- merchant's behalf. It is debited by a payout and credited by settlement,
-- which is what makes the invariant
--
--     sum(CREDIT) = sum(DEBIT)   across all accounts, per currency
--
-- hold. PSP_CLEARING represents money captured at the provider that has not
-- yet been swept into a merchant balance.
--
-- Adding an enum value is additive and cannot invalidate existing rows, so
-- this migration is safe to apply to a populated database. Existing rows are
-- left untouched: they are historical and remain auditable under the
-- single-entry convention that was in force when they were written. New rows
-- are fully balanced.

-- PostgreSQL cannot add a value inside a transaction that other statements
-- also use, so each ALTER TYPE is given its own implicit transaction.
ALTER TYPE "LedgerAccount" ADD VALUE IF NOT EXISTS 'MERCHANT_CLEARING';
ALTER TYPE "LedgerAccount" ADD VALUE IF NOT EXISTS 'PSP_CLEARING';

-- Backfill a counter-leg for every historical settlement so the opening
-- position reconciles. Without this the first reconciliation run reports a
-- permanent imbalance equal to all gross volume to date.
--
-- Each historical MERCHANT CREDIT gets a matching PSP_CLEARING DEBIT for the
-- same amount and reference, which is what the provider actually holds.
INSERT INTO "Ledgers" ("id", "publicId", "account", "accountKey", "merchantId", "currency", "amount", "type", "referenceId", "balanceAfter", "createdAt")
SELECT
  gen_random_uuid()::text,
  'pf-ledger-backfill-' || substr(md5(random()::text || l."id"), 1, 20),
  'PSP_CLEARING',
  l."accountKey",
  l."merchantId",
  l."currency",
  l."amount",
  'DEBIT',
  l."referenceId",
  NULL,
  l."createdAt"
FROM "Ledgers" l
WHERE l."account" = 'MERCHANT'
  AND l."type" = 'CREDIT'
  AND NOT EXISTS (
    SELECT 1 FROM "Ledgers" c
    WHERE c."account" = 'PSP_CLEARING'
      AND c."referenceId" = l."referenceId"
      AND c."type" = 'DEBIT'
  );

-- Historical payouts posted a lone DEBIT. Give each one the clearing CREDIT
-- it was always missing.
INSERT INTO "Ledgers" ("id", "publicId", "account", "accountKey", "merchantId", "currency", "amount", "type", "referenceId", "balanceAfter", "createdAt")
SELECT
  gen_random_uuid()::text,
  'pf-ledger-backfill-' || substr(md5(random()::text || l."id"), 1, 20),
  'MERCHANT_CLEARING',
  l."accountKey",
  l."merchantId",
  l."currency",
  l."amount",
  'CREDIT',
  l."referenceId",
  NULL,
  l."createdAt"
FROM "Ledgers" l
WHERE l."account" = 'MERCHANT'
  AND l."type" = 'DEBIT'
  AND NOT EXISTS (
    SELECT 1 FROM "Ledgers" c
    WHERE c."account" = 'MERCHANT_CLEARING'
      AND c."referenceId" = l."referenceId"
      AND c."type" = 'CREDIT'
  );

-- Reconciliation runs a per-currency balance check on every sweep; index it.
CREATE INDEX IF NOT EXISTS "Ledgers_account_currency_type_idx"
  ON "Ledgers" ("account", "currency", "type");