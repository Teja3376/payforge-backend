#!/usr/bin/env bash
#
# Start a live PayForge stack for API-level testing.
#
# Brings up PostgreSQL, applies the shipped migrations, seeds exchange rates
# and starts the real API. Personas then drive it over HTTP exactly as a
# merchant's integration would — no mocks, no stubs, real persistence.
#
#   scripts/live-stack.sh start    # background, logs to scripts/live/stack.log
#   scripts/live-stack.sh status
#   scripts/live-stack.sh stop
#   scripts/live-stack.sh curl <method> <path> [json]   # convenience
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$ROOT/scripts/live/stack.log"
PIDFILE="$ROOT/scripts/live/stack.pid"
PORT="${LIVE_API_PORT:-3100}"
BASE="http://127.0.0.1:${PORT}/v1"

case "${1:-start}" in
  start)
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "already running (pid $(cat "$PIDFILE"))"
      exit 0
    fi
    mkdir -p "$ROOT/test/live"
    : > "$LOG"
    cd "$ROOT"
    npx ts-node -P scripts/live/tsconfig.json scripts/live/stack.ts >>"$LOG" 2>&1 &
    echo $! > "$PIDFILE"

    # Wait for the port to answer rather than sleeping a fixed amount.
    for _ in $(seq 1 90); do
      if curl -fsS "${BASE}/health" >/dev/null 2>&1; then
        echo "stack up at ${BASE} (pid $(cat "$PIDFILE"))"
        echo "log: ${LOG}"
        exit 0
      fi
      if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "stack exited during startup. Last 40 log lines:"
        tail -40 "$LOG"
        exit 1
      fi
      sleep 1
    done
    echo "stack did not become ready in 90s. Last 40 log lines:"
    tail -40 "$LOG"
    exit 1
    ;;

  stop)
    if [[ -f "$PIDFILE" ]]; then
      PID="$(cat "$PIDFILE")"
      # ts-node spawns a child; kill the whole group.
      pkill -P "$PID" 2>/dev/null
      kill "$PID" 2>/dev/null
      rm -f "$PIDFILE"
      echo "stopped"
    else
      echo "not running"
    fi
    pkill -f "postgres.*payforge-it" 2>/dev/null
    ;;

  status)
    if curl -fsS "${BASE}/health" >/dev/null 2>&1; then
      echo "up: ${BASE}/health -> $(curl -fsS "${BASE}/health")"
      curl -fsS "${BASE}/health/ready" 2>/dev/null | head -c 600; echo
    else
      echo "down"
      tail -20 "$LOG" 2>/dev/null
    fi
    ;;

  curl)
    METHOD="$2"; PATH_="$3"; BODY="${4:-}"
    if [[ -n "$BODY" ]]; then
      curl -sS -X "$METHOD" "${BASE}${PATH_}" \
        -H 'content-type: application/json' \
        -H "authorization: ${STACK_TOKEN:-}" \
        -H "x-api-key: ${STACK_API_KEY:-}" \
        -d "$BODY" -w '\n[status %{http_code}]\n'
    else
      curl -sS -X "$METHOD" "${BASE}${PATH_}" \
        -H "authorization: ${STACK_TOKEN:-}" \
        -H "x-api-key: ${STACK_API_KEY:-}" \
        -w '\n[status %{http_code}]\n'
    fi
    ;;

  *)
    echo "usage: $0 {start|stop|status|curl <method> <path> [json]}"
    exit 1
    ;;
esac