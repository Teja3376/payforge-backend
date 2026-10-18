-- Indexes for the lease-based webhook sweep.
--
-- Depends on the 'IN_FLIGHT' value added by 20260418070000_webhook_delivery_lease,
-- which must therefore be a separate transaction.

-- The sweep filters on (status IN (PENDING, IN_FLIGHT)) AND nextAttemptAt,
-- and excludes deliveries belonging to a disabled endpoint. The old index was
-- on (status) alone.
CREATE INDEX IF NOT EXISTS "WebhookDelivery_sweep_idx"
  ON "WebhookDelivery" ("status", "nextAttemptAt")
  WHERE "status" IN ('PENDING', 'IN_FLIGHT');

-- Auto-disable counts dead deliveries per endpoint within a 24h window.
CREATE INDEX IF NOT EXISTS "WebhookDelivery_endpoint_status_idx"
  ON "WebhookDelivery" ("endpointId", "status", "updatedAt");