-- Bound fee schedules so they can never produce a zero net amount.
--
-- `Ledgers` carries CHECK ("amount" > 0), so a schedule that makes
-- net = gross - fee evaluate to 0 cannot be written to the journal. Previously
-- a merchant could self-serve basisPoints = 10000 via POST /merchants/me/fee-schedule,
-- which turned every subsequent settlement into a rollback with the bank charge
-- still captured.
--
-- Clamp any existing out-of-range rows first so the constraint can be added
-- without failing on a populated database.

UPDATE "Merchants"
   SET "defaultFeeBasisPoints" = 9900
 WHERE "defaultFeeBasisPoints" > 9900;

UPDATE "MerchantFeeSchedule"
   SET "basisPoints" = 9900
 WHERE "basisPoints" > 9900;

ALTER TABLE "Merchants" DROP CONSTRAINT IF EXISTS "Merchants_fee_bps_range";
ALTER TABLE "Merchants"
  ADD CONSTRAINT "Merchants_fee_bps_range"
  CHECK ("defaultFeeBasisPoints" BETWEEN 0 AND 9900);

ALTER TABLE "MerchantFeeSchedule" DROP CONSTRAINT IF EXISTS "MerchantFeeSchedule_bps_range";
ALTER TABLE "MerchantFeeSchedule"
  ADD CONSTRAINT "MerchantFeeSchedule_bps_range"
  CHECK ("basisPoints" BETWEEN 0 AND 9900);

-- Index the payout sweep. PayoutExecutor claims SCHEDULED rows every minute;
-- without this the scan degrades as completed payouts accumulate.
CREATE INDEX IF NOT EXISTS "Payout_status_scheduled_idx"
  ON "Payout" ("status", "createdAt")
  WHERE "status" = 'SCHEDULED';