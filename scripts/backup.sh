#!/usr/bin/env bash
#
# Logical backup of the PayForge database.
#
# The deployment checklist previously said "Database backups and
# point-in-time recovery verified" as a manual checkbox, with no script and no
# evidence. A backup nobody has restored is not a backup, so this script
# verifies its own output and restore.sh replays the same procedure.
#
# Usage:
#   scripts/backup.sh [output-dir]
#
# Requires DATABASE_URL (or a running docker-compose `db` service).

set -euo pipefail

OUT_DIR="${1:-./backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILENAME="payforge-${TIMESTAMP}.dump"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

mkdir -p "$OUT_DIR"

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
TARGET="${OUT_DIR}/${FILENAME}"

echo "==> backing up to ${TARGET}"

# --format=custom is compressed, parallel-restorable and lets pg_restore skip
# work it does not need. Plain SQL would also expose row data in the file.
pg_dump \
  --dbname="$DATABASE_URL" \
  --format=custom \
  --compress=6 \
  --no-owner \
  --no-privileges \
  --file="$TARGET"

# A zero-byte or truncated dump is worse than none: it looks like a backup and
# fails at restore time, which is the worst moment to discover that.
SIZE="$(wc -c < "$TARGET" | tr -d ' ')"
if [[ "$SIZE" -lt 1024 ]]; then
  echo "error: backup is only ${SIZE} bytes — refusing to report success" >&2
  rm -f "$TARGET"
  exit 1
fi

# Verify the archive is readable and record the schema version alongside it, so
# a restore can be checked against the right migration set.
if pg_restore --list "$TARGET" > /dev/null 2>&1; then
  echo "==> archive verified (${SIZE} bytes)"
else
  echo "error: pg_restore cannot read the archive — the backup is corrupt" >&2
  rm -f "$TARGET"
  exit 1
fi

psql "$DATABASE_URL" --no-psqlrc --tuples-only --command \
  "SELECT string_agg(migration_name, E'\n') FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at" \
  > "${TARGET%.dump}.migrations.txt" 2>/dev/null || true

CHECKSUM="$(shasum -a 256 "$TARGET" | awk '{print $1}')"
echo "${CHECKSUM}  ${FILENAME}" >> "${OUT_DIR}/checksums.sha256"

echo "==> pruning backups older than ${RETENTION_DAYS} days"
find "$OUT_DIR" -name 'payforge-*.dump' -type f -mtime "+${RETENTION_DAYS}" -print -delete
find "$OUT_DIR" -name 'payforge-*.migrations.txt' -type f -mtime "+${RETENTION_DAYS}" -delete

echo "==> backup complete: ${TARGET}"
echo "    sha256 ${CHECKSUM}"
echo "    restore with: scripts/restore.sh ${TARGET}"