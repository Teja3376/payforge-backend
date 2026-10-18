#!/usr/bin/env bash
#
# Restore the database from a logical backup.
#
# Destructive: replaces the target database. Refuses to run against a database
# that does not look like a dev/staging instance unless --force is given.
#
# Usage:
#   scripts/restore.sh ./backups/payforge-20260418T120000Z.dump [--force]
#
# After restoring, always re-apply migrations: the backup may predate the
# running image's schema.

set -euo pipefail

ARCHIVE="${1:-}"
FORCE="${2:-}"

if [[ -z "$ARCHIVE" ]]; then
  echo "usage: scripts/restore.sh <archive.dump> [--force]" >&2
  exit 1
fi
if [[ ! -f "$ARCHIVE" ]]; then
  echo "error: no such archive: ${ARCHIVE}" >&2
  exit 1
fi

resolve_database_url() {
  if [[ -n "${DATABASE_URL:-}" ]]; then
    echo "$DATABASE_URL"
    return
  fi
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx 'payforge-db'; then
    echo "postgresql://payforge:payforge@127.0.0.1:5432/payforge?schema=public"
    return
  fi
  echo "error: set DATABASE_URL or start the docker-compose db service" >&2
  exit 1
}

DATABASE_URL="$(resolve_database_url)"

# --- Guard against restoring over production --------------------------------
# The single most damaging thing this script could do is run against prod by
# accident, so it refuses unless the operator says otherwise.
if [[ "$DATABASE_URL" != *"localhost"* && "$DATABASE_URL" != *"127.0.0.1"* && "$FORCE" != "--force" ]]; then
  echo "refusing to restore over a non-local database: ${DATABASE_URL}" >&2
  echo "re-run with --force if this is intended" >&2
  exit 1
fi

echo "==> verifying archive checksum"
if [[ -f "$(dirname "$ARCHIVE")/checksums.sha256" ]]; then
  ( cd "$(dirname "$ARCHIVE")" && shasum -a 256 -c checksums.sha256 2>/dev/null | grep -F "$(basename "$ARCHIVE")" ) || {
    echo "error: checksum mismatch — the archive is not the one that was written" >&2
    exit 1
  }
  echo "    checksum ok"
fi

if ! pg_restore --list "$ARCHIVE" > /dev/null 2>&1; then
  echo "error: archive is unreadable; it was truncated or corrupted" >&2
  exit 1
fi

echo "==> dropping and recreating public schema"
# --clean --if-exists would leave objects that were dropped from the schema
# behind in some edge cases. Recreating the schema outright is unambiguous.
psql "$DATABASE_URL" --no-psqlrc --command 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;' > /dev/null

echo "==> restoring"
# --exit-on-error so a partial restore fails loudly rather than leaving a
# half-populated money ledger.
pg_restore \
  --dbname="$DATABASE_URL" \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  "$ARCHIVE"

echo "==> applying migrations"
npx prisma migrate deploy

echo "==> post-restore verification"
COUNTS=$(psql "$DATABASE_URL" --no-psqlrc --tuples-only --command "
  SELECT 'merchants='  || (SELECT count(*) FROM \"Merchants\")
      || ' payments='  || (SELECT count(*) FROM \"Payments\")
      || ' txns='      || (SELECT count(*) FROM \"Transactions\")
      || ' ledger='    || (SELECT count(*) FROM \"Ledgers\");
")
echo "    ${COUNTS}"

# The ledger must balance after a restore. If it does not, the archive was
# taken from an inconsistent database and the money figures cannot be trusted.
IMBALANCE=$(psql "$DATABASE_URL" --no-psqlrc --tuples-only --command "
  SELECT count(*) FROM (
    SELECT \"currency\"
    FROM \"Ledgers\"
    GROUP BY \"currency\"
    HAVING COALESCE(SUM(\"amount\") FILTER (WHERE \"type\" = 'CREDIT'), 0)
         <> COALESCE(SUM(\"amount\") FILTER (WHERE \"type\" = 'DEBIT'), 0)
  ) t;
")

if [[ "$IMBALANCE" != "0" ]]; then
  echo "error: ${IMBALANCE} currency/currencies do not balance after restore." >&2
  echo "       Do not resume traffic until this is investigated." >&2
  exit 1
fi

echo "==> restore verified: the journal balances"
echo "    Start the API and check /v1/health/ready before routing traffic."