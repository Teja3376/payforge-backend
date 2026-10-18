-- Allow system-initiated audit entries.
--
-- Resolution.actorId was NOT NULL with a foreign key to Users. A settlement
-- driven by an inbound provider callback, a reconciliation break, or any other
-- scheduled sweep has no user behind it, so these events could not be
-- recorded — the stranded-capture path previously emitted only a log line
-- precisely because there was nowhere durable to put it.
--
-- actorId becomes nullable. The foreign key still constrains every USER and
-- API_KEY actor; only SYSTEM rows may omit it.

ALTER TABLE "Resolution" ALTER COLUMN "actorId" DROP NOT NULL;

-- Resolution actions added for compliance and reconciliation auditing.
ALTER TYPE "ResolutionAction" ADD VALUE IF NOT EXISTS 'SETTLE_CANCELLED_PAYMENT';
ALTER TYPE "ResolutionAction" ADD VALUE IF NOT EXISTS 'KYC_APPROVED';
ALTER TYPE "ResolutionAction" ADD VALUE IF NOT EXISTS 'KYC_REJECTED';
ALTER TYPE "ResolutionAction" ADD VALUE IF NOT EXISTS 'RECONCILIATION_BREAK';