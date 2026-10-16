#!/bin/zsh
set -u
umask 077

export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin"
PROJECT_ROOT="${CHESTNY_PROJECT_ROOT:-/Users/koredigital/Developer/chestny-prigon}"
STATE_DIR="${CHESTNY_WORKER_STATE_DIR:-/Users/koredigital/Library/Application Support/chestny-prigon}"
LOG_DIR="${CHESTNY_WORKER_LOG_DIR:-/Users/koredigital/Library/Logs/chestny-prigon}"
REQUEST_FILE="$STATE_DIR/active-run"
WAVE_SIZE_FILE="$STATE_DIR/active-wave-size"
MODE_FILE="$STATE_DIR/active-mode"
TRANSPORT_FILE="$STATE_DIR/active-transport"
LOG_FILE="$LOG_DIR/worker.log"

/bin/mkdir -p "$STATE_DIR" "$LOG_DIR"
/bin/chmod 700 "$STATE_DIR"

rotate_log() {
  [[ -f "$LOG_FILE" ]] || return 0
  local size
  size=$(/usr/bin/stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)
  (( size < 10485760 )) && return 0
  local index
  for index in 4 3 2 1; do
    [[ -f "$LOG_FILE.$index" ]] && /bin/mv -f "$LOG_FILE.$index" "$LOG_FILE.$((index + 1))"
  done
  /bin/mv -f "$LOG_FILE" "$LOG_FILE.1"
}

if [[ ! -s "$REQUEST_FILE" ]]; then
  exit 0
fi

RUN_ID=$(/bin/cat "$REQUEST_FILE" | /usr/bin/tr -d '\r\n')
if ! /usr/bin/printf '%s' "$RUN_ID" | /usr/bin/grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'; then
  /usr/bin/printf '%s invalid active-run request; refusing to start\n' "$(/bin/date -u +%FT%TZ)" >> "$LOG_FILE"
  exit 64
fi

MAX_ITEMS=50
if [[ -s "$WAVE_SIZE_FILE" ]]; then
  MAX_ITEMS=$(/bin/cat "$WAVE_SIZE_FILE" | /usr/bin/tr -d '\r\n')
fi
if ! /usr/bin/printf '%s' "$MAX_ITEMS" | /usr/bin/grep -Eq '^[0-9]{1,3}$' || (( MAX_ITEMS < 1 || MAX_ITEMS > 500 )); then
  /usr/bin/printf '%s invalid wave size %s; refusing to start\n' "$(/bin/date -u +%FT%TZ)" "$MAX_ITEMS" >> "$LOG_FILE"
  exit 64
fi

RUN_MODE=""
if [[ -s "$MODE_FILE" ]]; then
  RUN_MODE=$(/bin/cat "$MODE_FILE" | /usr/bin/tr -d '\r\n')
  if [[ "$RUN_MODE" != "targeted_report_refresh" && "$RUN_MODE" != "saved_queue_until_complete" ]]; then
    /usr/bin/printf '%s invalid active mode %s; refusing to start\n' "$(/bin/date -u +%FT%TZ)" "$RUN_MODE" >> "$LOG_FILE"
    exit 64
  fi
fi

if [[ ! -s "$TRANSPORT_FILE" ]]; then
  /usr/bin/printf '%s missing active transport; refusing to choose a network route implicitly\n' "$(/bin/date -u +%FT%TZ)" >> "$LOG_FILE"
  exit 64
fi
TRANSPORT=$(/bin/cat "$TRANSPORT_FILE" | /usr/bin/tr -d '\r\n')
if [[ "$TRANSPORT" != "proxy" && "$TRANSPORT" != "direct" ]]; then
  /usr/bin/printf '%s invalid active transport %s; refusing to start\n' "$(/bin/date -u +%FT%TZ)" "$TRANSPORT" >> "$LOG_FILE"
  exit 64
fi

rotate_log
/usr/bin/printf '%s starting run %s max-items=%s transport=%s\n' "$(/bin/date -u +%FT%TZ)" "$RUN_ID" "$MAX_ITEMS" "$TRANSPORT" >> "$LOG_FILE"
cd "$PROJECT_ROOT" || exit 72

# The worker owns duplicate and stale-lock handling. Do not reject a lock file
# here: after a Mac restart its PID is stale, and the worker can safely recover it.

if [[ "$RUN_MODE" == "targeted_report_refresh" ]]; then
  /opt/homebrew/opt/node@24/bin/npm run catalog:worker-local -- --run-id="$RUN_ID" --transport="$TRANSPORT" --until-complete --allow-matching-staging-refresh --targeted-report-refresh-delay-ms=2000 --targeted-report-refresh-concurrency=2 >> "$LOG_FILE" 2>&1 &
elif [[ "$RUN_MODE" == "saved_queue_until_complete" ]]; then
  /opt/homebrew/opt/node@24/bin/npm run catalog:worker-local -- --run-id="$RUN_ID" --transport="$TRANSPORT" --until-complete >> "$LOG_FILE" 2>&1 &
else
  /opt/homebrew/opt/node@24/bin/npm run catalog:worker-local -- --run-id="$RUN_ID" --transport="$TRANSPORT" --max-items="$MAX_ITEMS" >> "$LOG_FILE" 2>&1 &
fi
WORKER_PID=$!
/usr/bin/caffeinate -i -w "$WORKER_PID" &
AWAKE_PID=$!
trap '/bin/kill -TERM "$WORKER_PID" 2>/dev/null || true; wait "$WORKER_PID" 2>/dev/null || true; exit 143' TERM INT
wait "$WORKER_PID"
STATUS=$?
/bin/kill "$AWAKE_PID" 2>/dev/null || true
wait "$AWAKE_PID" 2>/dev/null || true
trap - TERM INT

if (( STATUS == 0 )) && [[ -f "$REQUEST_FILE" ]] && [[ "$(/bin/cat "$REQUEST_FILE" | /usr/bin/tr -d '\r\n')" == "$RUN_ID" ]]; then
  /bin/rm "$REQUEST_FILE"
  /bin/rm -f "$WAVE_SIZE_FILE"
  if [[ -n "$RUN_MODE" ]] && [[ -f "$MODE_FILE" ]] && [[ "$(/bin/cat "$MODE_FILE" | /usr/bin/tr -d '\r\n')" == "$RUN_MODE" ]]; then
    /bin/rm -f "$MODE_FILE"
  fi
fi
/usr/bin/printf '%s worker exited status=%s run=%s\n' "$(/bin/date -u +%FT%TZ)" "$STATUS" "$RUN_ID" >> "$LOG_FILE"
exit "$STATUS"
