-- Compliance schema: provider onboarding status and risk screening.
--
-- Accepting a merchant in PayForge is not the same as being accepted by a bank
-- or payment provider. These models record the *external* party's view
-- separately, so enabling live mode requires both systems to agree rather than
-- trusting PayForge's own approval alone.
--
-- Previously there was no field anywhere for provider activation status
-- (charges_enabled / payouts_enabled), beneficial owners, sanctions or PEP
-- screening. `grep -i 'stripeAccount|charges_enabled|payouts_enabled'` and
-- `grep -i 'sanctions|pep'` both returned nothing.

CREATE TABLE "MerchantRisk" (
    "id"                  TEXT NOT NULL,
    "merchantId"          TEXT NOT NULL,
    "riskScore"           INTEGER NOT NULL DEFAULT 0,
    "sanctionsChecked"    BOOLEAN NOT NULL DEFAULT false,
    "sanctionsCheckedAt"  TIMESTAMP(3),
    "pepChecked"          BOOLEAN NOT NULL DEFAULT false,
    "pepCheckedAt"        TIMESTAMP(3),
    "chargebackRate"      DOUBLE PRECISION NOT NULL DEFAULT 0,
    "chargebackUpdatedAt" TIMESTAMP(3),
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantRisk_pkey" PRIMARY KEY ("id")
);

-- The enum must exist before the table that uses it as a column type. Creating
-- the table first fails with `type "ProviderOnboarding" does not exist`.
CREATE TYPE "ProviderOnboarding" AS ENUM ('NOT_STARTED', 'PENDING', 'RESTRICTED', 'ENABLED', 'DISABLED');

CREATE TABLE "MerchantProviderAccount" (
    "id"                TEXT NOT NULL,
    "publicId"          TEXT NOT NULL,
    "merchantId"        TEXT NOT NULL,
    "provider"          TEXT NOT NULL,
    "providerAccountId" TEXT,
    "onboardingStatus"  "ProviderOnboarding" NOT NULL DEFAULT 'NOT_STARTED',
    "chargesEnabled"    BOOLEAN NOT NULL DEFAULT false,
    "payoutsEnabled"    BOOLEAN NOT NULL DEFAULT false,
    "requirementsDue"   TEXT,
    "lastSyncedAt"      TIMESTAMP(3),
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantProviderAccount_pkey" PRIMARY KEY ("id")
);

-- One provider account per merchant; more than one PSP would need a unique
-- index on (merchantId, provider) instead.
CREATE UNIQUE INDEX "MerchantRisk_merchantId_key" ON "MerchantRisk"("merchantId");
CREATE UNIQUE INDEX "MerchantProviderAccount_publicId_key" ON "MerchantProviderAccount"("publicId");
CREATE UNIQUE INDEX "MerchantProviderAccount_merchantId_key" ON "MerchantProviderAccount"("merchantId");
CREATE INDEX "MerchantProviderAccount_provider_onboardingStatus_idx"
  ON "MerchantProviderAccount"("provider", "onboardingStatus");

DO $$ BEGIN
    ALTER TABLE "MerchantRisk"
      ADD CONSTRAINT "MerchantRisk_merchantId_fkey"
      FOREIGN KEY ("merchantId") REFERENCES "Merchants"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "MerchantProviderAccount"
      ADD CONSTRAINT "MerchantProviderAccount_merchantId_fkey"
      FOREIGN KEY ("merchantId") REFERENCES "Merchants"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Risk score is a 0-100 band, not a regulatory definition.
ALTER TABLE "MerchantRisk" ADD CONSTRAINT "MerchantRisk_score_range" CHECK ("riskScore" BETWEEN 0 AND 100);
ALTER TABLE "MerchantRisk" ADD CONSTRAINT "MerchantRisk_chargeback_rate" CHECK ("chargebackRate" >= 0 AND "chargebackRate" <= 1);

-- Admin KYC review notes, distinct from the merchant-visible rejectionReason.
ALTER TABLE "MerchantKyc" ADD COLUMN IF NOT EXISTS "reviewNotes" TEXT;

-- Refresh token families, so presenting an already-rotated token can revoke
-- the whole family rather than a single row.
--
-- `@@unique([userId, familyId])` cannot be created as a constraint because a
-- login mints the first session in a family with its own id, and rotations
-- would then collide. Uniqueness is enforced in the service instead, inside
-- the same transaction that rotates.
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "familyId" TEXT;
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "revokedReason" TEXT;
CREATE INDEX IF NOT EXISTS "Session_familyId_idx" ON "Session"("familyId");