#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PID_FILE="$ROOT/data/server.pid"
LOG_FILE="$ROOT/data/server.log"
RUN_LOG_FILE="$ROOT/data/run.log"

mkdir -p "$ROOT/data"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*" >>"$RUN_LOG_FILE"
}

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

cleanup_agents() {
  ps -ef \
    | awk '/phone-hub\/agent-codex\.js|voice-agent|phone-hub-codex-/ && !/awk/ {print $2}' \
    | while read -r pid; do
        [ -n "$pid" ] || continue
        kill "$pid" 2>/dev/null || true
      done
  sleep 1
  ps -ef \
    | awk '/phone-hub\/agent-codex\.js|voice-agent|phone-hub-codex-/ && !/awk/ {print $2}' \
    | while read -r pid; do
        [ -n "$pid" ] || continue
        kill -KILL "$pid" 2>/dev/null || true
      done
}

cleanup_stale_servers() {
  ps -ef \
    | awk '/node server\.js/ && !/awk/ {print $2}' \
    | while read -r pid; do
        [ -n "$pid" ] || continue
        cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
        if [ "$cwd" = "$ROOT" ]; then
          log "stopping stale server pid $pid"
          kill "$pid" 2>/dev/null || true
        fi
      done
  sleep 1
  ps -ef \
    | awk '/node server\.js/ && !/awk/ {print $2}' \
    | while read -r pid; do
        [ -n "$pid" ] || continue
        cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
        if [ "$cwd" = "$ROOT" ]; then
          log "force stopping stale server pid $pid"
          kill -KILL "$pid" 2>/dev/null || true
        fi
      done
}

take_wake_lock() {
  if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock >/dev/null 2>&1 || log "termux-wake-lock failed"
  else
    log "termux-wake-lock not found"
  fi
}

stop_server() {
  cleanup_agents
  if is_running; then
    log "stopping server pid $(cat "$PID_FILE")"
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    i=0
    while is_running && [ "$i" -lt 30 ]; do
      sleep 1
      i=$((i + 1))
    done
    if is_running; then
      log "server did not stop cleanly; sending SIGKILL"
      kill -KILL "$(cat "$PID_FILE")" 2>/dev/null || true
    fi
  fi
  cleanup_stale_servers
  cleanup_agents
}

start_server() {
  cleanup_agents
  cleanup_stale_servers
  take_wake_lock
  cd "$ROOT"
  setsid env \
    VOICE_AGENT_CMD="$ROOT/agent-codex.js" \
    VOICE_AGENT_TIMEOUT_MS="${VOICE_AGENT_TIMEOUT_MS:-60000}" \
    VOICE_HTTP_TOTAL_TIMEOUT_MS="${VOICE_HTTP_TOTAL_TIMEOUT_MS:-10000}" \
    CODEX_AGENT_TIMEOUT_MS="${CODEX_AGENT_TIMEOUT_MS:-25000}" \
    CODEX_AGENT_MODEL="${CODEX_AGENT_MODEL:-}" \
    VOICE_DEFAULT_LOCATION="${VOICE_DEFAULT_LOCATION:-}" \
    node server.js >"$LOG_FILE" 2>&1 &
  echo "$!" >"$PID_FILE"
  sleep 1
  if ! is_running; then
    log "failed to start"
    echo "failed to start; see $LOG_FILE" >&2
    exit 1
  fi
  log "started server pid $(cat "$PID_FILE")"
}

case "${1:-restart}" in
  start)
    if is_running; then
      echo "already running"
    else
      start_server
      echo "started"
    fi
    ;;
  stop)
    stop_server
    echo "stopped"
    ;;
  restart)
    stop_server
    start_server
    echo "restarted"
    ;;
  status)
    if is_running; then
      echo "running $(cat "$PID_FILE")"
    else
      echo "stopped"
    fi
    ;;
  cleanup-agents)
    cleanup_agents
    echo "cleaned"
    ;;
  wake-lock)
    take_wake_lock
    echo "wake-lock requested"
    ;;
  *)
    echo "usage: $0 start|stop|restart|status|cleanup-agents|wake-lock" >&2
    exit 2
    ;;
esac
