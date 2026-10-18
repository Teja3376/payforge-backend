-- Two-phase refunds.
--
-- A provider refund is irreversible: once the money is back on the cardholder's
-- card there is nothing to compensate with, unlike a charge which can be voided.
-- Posting the ledger reversal optimistically and calling the bank afterwards
-- would mean a merchant's balance is debited for a refund that may never have
-- happened, and an operator reversing it by hand.
--
-- Refunds are now a saga:
--   1. Reserve the idempotency key with a PENDING row (committed on its own).
--      This also gives the refund path the read-side idempotency check it
--      previously lacked — a retry returned 409 instead of the original refund.
--   2. Call the provider.
--   3. On success, apply the ledger reversal and mark SUCCEEDED.
--   4. On failure, mark FAILED.
--
-- A row still PENDING after step 2 means the process died mid-flight. The
-- provider has either taken the refund or not; ReconciliationService resolves
-- it by querying gatewayRefundRef. Recording that reference is what makes the
-- stranded case resolvable without risking a double refund.

ALTER TABLE "Refund" ADD COLUMN IF NOT EXISTS "gatewayRefundRef" TEXT;
ALTER TABLE "Refund" ADD COLUMN IF NOT EXISTS "failureReason" TEXT;

-- The previous default of SUCCEEDED asserted success before the provider was
-- ever contacted. The row is now reserved as PENDING and only advances once the
-- provider confirms.
ALTER TABLE "Refund" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- Reconciliation sweeps for stranded PENDING refunds.
CREATE INDEX IF NOT EXISTS "Refund_status_createdAt_idx"
  ON "Refund" ("status", "createdAt");