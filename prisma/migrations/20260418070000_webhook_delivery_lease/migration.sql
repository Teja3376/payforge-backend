-- Lease-based webhook delivery claims.
--
-- The sweep claimed a delivery by flipping it PENDING -> FAILED *before* the
-- HTTP request, and only moved it back on success or on a scheduled retry. A
-- process kill between the claim and the terminal write therefore left the row
-- in FAILED, which the sweep never reads because it filters on PENDING. Those
-- deliveries were stranded permanently with no reaper — the exact failure the
-- "sweep anything left PENDING by a process restart" comment claimed to catch.
--
-- IN_FLIGHT is now the claimed state, and `nextAttemptAt` carries a lease while
-- it is held. A row still IN_FLIGHT past its lease belonged to a dead process
-- and is reclaimed by the next sweep.

ALTER TYPE "DeliveryStatus" ADD VALUE IF NOT EXISTS 'IN_FLIGHT';

-- The sweep now filters on (status IN (PENDING, IN_FLIGHT)) AND nextAttemptAt,
-- and excludes deliveries belonging to a disabled endpoint. The old index was
-- (status) only.
CREATE INDEX IF NOT EXISTS "WebhookDelivery_sweep_idx"
  ON "WebhookDelivery" ("status", "nextAttemptAt")
  WHERE "status" IN ('PENDING', 'IN_FLIGHT');

-- Auto-disable counts dead deliveries per endpoint within a 24h window.
CREATE INDEX IF NOT EXISTS "WebhookDelivery_endpoint_status_idx"
  ON "WebhookDelivery" ("endpointId", "status", "updatedAt");