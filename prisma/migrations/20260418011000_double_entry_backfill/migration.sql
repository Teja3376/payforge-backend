-- Backfill counter-legs for historical rows, and index for reconciliation.
--
-- Runs after 20260418010000_double_entry_accounts, which only adds the enum
-- values. Splitting them is required, not stylistic: PostgreSQL refuses to use
-- an enum value added by ALTER TYPE ... ADD VALUE inside the same transaction
-- that added it, and each migration file runs as one transaction. Keeping the
-- backfill in the same file made the migration fail with
--
--   unsafe use of new value "PSP_CLEARING" of enum type "LedgerAccount"
--
-- which means this migration had never been run — it was written but never
-- executed against a database.

-- Each historical MERCHANT CREDIT gets a matching PSP_CLEARING DEBIT for the
-- same amount and reference, which is what the provider actually holds.
-- Without this the first reconciliation run reports a permanent imbalance
-- equal to all gross volume to date.
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