-- PAYOUT_SCHEDULED is a new outbound event type.
--
-- Previously POST /payouts emitted PAYOUT_PAID immediately after creating a
-- SCHEDULED row, so a merchant's integration was told money had been sent
-- while the balance debit had not yet been matched by any bank transfer.
-- Creation now announces PAYOUT_SCHEDULED; PAYOUT_PAID is emitted only once
-- PayoutExecutor has the provider's confirmation.

-- Adding an enum value is additive; existing rows remain valid.
ALTER TYPE "WebhookEventType" ADD VALUE IF NOT EXISTS 'PAYOUT_SCHEDULED';