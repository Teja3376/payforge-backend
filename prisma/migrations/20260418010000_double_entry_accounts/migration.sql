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
-- This file is deliberately enum-only. PostgreSQL cannot use a value added by
-- ALTER TYPE ... ADD VALUE within the same transaction that added it, and a
-- migration file runs as one transaction. The backfill that *writes* these
-- values therefore has to live in a separate, later migration.

ALTER TYPE "LedgerAccount" ADD VALUE IF NOT EXISTS 'MERCHANT_CLEARING';
ALTER TYPE "LedgerAccount" ADD VALUE IF NOT EXISTS 'PSP_CLEARING';