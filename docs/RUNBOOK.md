# Operations runbook

Replaces the seven-item manual checklist in the README, which asserted things
without evidence — including "Database backups and point-in-time recovery
verified", which had no script behind it.

---

## Health endpoints

| Endpoint | Use | 503 when |
| --- | --- | --- |
| `GET /v1/health` | Liveness / restart probe | Never. Deliberately touches no dependency, so a database blip cannot cause the orchestrator to restart a healthy process. |
| `GET /v1/health/ready` | Readiness / route traffic | The database is unreachable, **and only then**. |
| `GET /v1/health/metrics` | Prometheus scrape | Never |

### Readiness reports `degraded` with 200

A degraded process is still serving most traffic and must not be restarted:

| Dependency | Degraded when | Customer impact |
| --- | --- | --- |
| `exchange-rates` | Newest snapshot is over 5 days old | Cross-currency payments fail; same-currency unaffected |
| `ledger-balance` | Any currency has credits ≠ debits | **None immediately** — this is a backstop |
| `payouts` | Payouts stuck `IN_TRANSIT` past 15 min | Merchant payouts delayed |
| `refunds` (via metrics) | Refunds stranded `PENDING` past 15 min | Merchant refunds awaiting resolution |

Treat `degraded` as a page for `ledger-balance`, a ticket for the rest.

---

## Metrics worth alerting on

Scrape `/v1/health/metrics`. The ones that matter:

```promql
# Money integrity — page immediately on any non-zero value.
payforge_ledger_imbalance_minor > 0

# A refund that reached the provider but not the ledger.
payforge_refunds_stranded > 0

# A charge with no provider callback. Blocks further charges on that payment.
payforge_transactions_pending_stale > 0

# We do not know whether the money moved.
increase(payforge_payouts_in_flight_stuck[15m]) > 0

# Cross-currency payments are failing while the process looks healthy.
payforge_ledger_imbalance_minor == 0 and rate(payforge_http_requests_total{status=~"4..",route="/payments"}[5m]) > 0.1
```

`payforge_ledger_imbalance_minor` is the single most important signal in the
platform. It is non-zero if and only if money has been created or destroyed.

---

## Backup and restore

```bash
scripts/backup.sh                 # → backups/payforge-<timestamp>.dump + checksum
scripts/restore.sh <archive>      # local only; --force for anything else
```

**Test the restore on a schedule.** An untested backup is not a backup. The
restore script re-verifies the checksum, checks `pg_restore` can read the
archive, re-applies migrations, and asserts the journal balances before it
reports success.

Nightly cron:

```cron
17 3 * * *  cd /srv/payforge && DATABASE_URL=… ./scripts/backup.sh >> /var/log/payforge-backup.log 2>&1
```

Retention is 30 days by default (`BACKUP_RETENTION_DAYS`).

Point-in-time recovery requires WAL archiving, which `docker-compose.yml`
enables. For a managed instance, confirm your provider has PITR configured —
`pg_dump` alone cannot recover to an arbitrary point in time.

---

## Deploying

```bash
npm ci
npx prisma migrate deploy    # never `migrate dev` against production
npm run build
npm run build:packages
node dist/main
```

Or with the image:

```bash
docker build -t payforge:$(git rev-parse --short HEAD) .
docker run --env-file .env -p 3000:3000 payforge:$(git rev-parse --short HEAD)
```

Roll back by running the previous image. Note that migrations are not
automatically reversible — write them so that rolling back the application is
safe while the schema stays at the newer version.

---

## Incident procedures

### The journal does not balance

```bash
psql "$DATABASE_URL" --tuples-only -c "
  SELECT \"currency\",
         COALESCE(SUM(\"amount\") FILTER (WHERE \"type\"='CREDIT'),0) AS credits,
         COALESCE(SUM(\"amount\") FILTER (WHERE \"type\") ,0) AS debits
  FROM \"Ledgers\" GROUP BY \"currency\";"
```

```sql
SELECT "publicId","account","amount","type","referenceId","createdAt"
FROM "Ledgers"
WHERE "referenceId" IN (
  SELECT "referenceId" FROM "Ledgers"
  WHERE "referenceId" = '<the suspect reference>'
)
ORDER BY "createdAt";
```

Every movement writes a complete set of legs under one `referenceId`. An odd
count, or legs that do not sum to zero, identifies the broken write. Because
the ledger is append-only and trigger-protected, **correct it by posting a
compensating entry** — never by updating or deleting.

### A payout is stuck

1. Check the provider first. The platform genuinely does not know whether the
   money moved, and the balance was already debited at schedule time.
2. If the provider shows no transfer: `POST /admin/...` has no payout retry
   endpoint yet — resolve manually with `markFailed`, which returns the debit.
3. If the provider shows a transfer: the payout is `IN_TRANSIT`, not stuck; let
   it settle or reconcile by hand.

### A refund is stranded

`payforge_refunds_stranded > 0`. The provider may or may not have processed it.
**Do not retry the refund.** Query the provider by `gatewayRefundRef`; the
hourly sweeper completes it automatically if the provider confirms success.

### Exchange rates are stale

Check whether the provider is reachable, then:

```bash
curl -sS "$FX_PROVIDER_URL/$FX_PROVIDER_API_KEY/latest/USD"
npx prisma db execute --stdin <<< "INSERT INTO \"ExchangeRateSnapshot\" …"
```

Cross-currency payment creation is failing while the readiness probe reports
`degraded`. Same-currency traffic is unaffected.

---

## Pre-launch checklist

- [ ] CI green on the exact commit being deployed
- [ ] Backup taken and **restore rehearsed** within the last 30 days
- [ ] Migrations reviewed by hand for reversibility
- [ ] Prometheus scraping `/v1/health/metrics`; alerts on `ledger_imbalance_minor`
- [ ] Readiness wired to the orchestrator; liveness to the restart probe
- [ ] A real provider adapter wired behind `BANK_PORT`, exercised in its sandbox
- [ ] `ENABLE_DEV_TOOLS` **not** set to `true`
- [ ] Every merchant `ACTIVE` has KYC approved and provider `chargesEnabled`
- [ ] No merchant in `LIVE` mode without a provider account