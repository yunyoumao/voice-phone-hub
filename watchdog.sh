#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PID_FILE="$ROOT/data/watchdog.pid"
LOG_FILE="$ROOT/data/watchdog.log"
INTERVAL="${PHONE_HUB_WATCHDOG_INTERVAL:-60}"
URL="${PHONE_HUB_HEALTH_URL:-http://127.0.0.1:8787/}"

mkdir -p "$ROOT/data"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*" >>"$LOG_FILE"
}

is_watchdog_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

check_once() {
  code=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "$URL" 2>/dev/null || true)
  case "$code" in
    200|301|302|401|403)
      return 0
      ;;
    *)
      log "health check failed: HTTP_${code:-000}; restarting phone-hub"
      "$ROOT/run.sh" restart >>"$LOG_FILE" 2>&1 || log "restart failed"
      ;;
  esac
}

run_loop() {
  echo "$$" >"$PID_FILE"
  log "watchdog started interval=${INTERVAL}s url=$URL"
  "$ROOT/run.sh" wake-lock >>"$LOG_FILE" 2>&1 || true
  while true; do
    check_once
    sleep "$INTERVAL"
  done
}

case "${1:-start}" in
  start)
    if is_watchdog_running; then
      echo "already running $(cat "$PID_FILE")"
    else
      setsid "$0" loop >/dev/null 2>&1 &
      sleep 1
      if is_watchdog_running; then
        echo "started $(cat "$PID_FILE")"
      else
        echo "failed to start; see $LOG_FILE" >&2
        exit 1
      fi
    fi
    ;;
  loop)
    run_loop
    ;;
  stop)
    if is_watchdog_running; then
      kill "$(cat "$PID_FILE")" 2>/dev/null || true
      echo "stopped"
    else
      echo "stopped"
    fi
    ;;
  restart)
    "$0" stop >/dev/null 2>&1 || true
    "$0" start
    ;;
  status)
    if is_watchdog_running; then
      echo "running $(cat "$PID_FILE")"
    else
      echo "stopped"
    fi
    ;;
  once)
    check_once
    echo "checked"
    ;;
  *)
    echo "usage: $0 start|stop|restart|status|once" >&2
    exit 2
    ;;
esac
