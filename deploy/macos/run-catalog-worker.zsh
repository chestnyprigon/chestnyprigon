#!/bin/zsh
set -u
umask 077

export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin"
PROJECT_ROOT="${CHESTNY_PROJECT_ROOT:-/Users/koredigital/Developer/chestny-prigon}"
STATE_DIR="${CHESTNY_WORKER_STATE_DIR:-/Users/koredigital/Library/Application Support/chestny-prigon}"
LOG_DIR="${CHESTNY_WORKER_LOG_DIR:-/Users/koredigital/Library/Logs/chestny-prigon}"
REQUEST_FILE="$STATE_DIR/active-run"
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

rotate_log
/usr/bin/printf '%s starting run %s\n' "$(/bin/date -u +%FT%TZ)" "$RUN_ID" >> "$LOG_FILE"
cd "$PROJECT_ROOT" || exit 72

# The worker has its own global DB/file lock. Recheck here so a manual
# launchctl kickstart or duplicate request cannot terminate a legitimate run.
if [[ -e /tmp/encar-coordination/chestny-catalog-enrichment.lock ]]; then
  /usr/bin/printf '%s global worker lock is already present; refusing duplicate launch\n' "$(/bin/date -u +%FT%TZ)" >> "$LOG_FILE"
  exit 75
fi

/opt/homebrew/opt/node@24/bin/npm run catalog:worker-local -- --run-id="$RUN_ID" --max-items=50 >> "$LOG_FILE" 2>&1 &
WORKER_PID=$!
trap '/bin/kill -TERM "$WORKER_PID" 2>/dev/null || true; wait "$WORKER_PID" 2>/dev/null || true; exit 143' TERM INT
wait "$WORKER_PID"
STATUS=$?
trap - TERM INT

if (( STATUS == 0 )) && [[ -f "$REQUEST_FILE" ]] && [[ "$(/bin/cat "$REQUEST_FILE" | /usr/bin/tr -d '\r\n')" == "$RUN_ID" ]]; then
  /bin/rm "$REQUEST_FILE"
fi
/usr/bin/printf '%s worker exited status=%s run=%s\n' "$(/bin/date -u +%FT%TZ)" "$STATUS" "$RUN_ID" >> "$LOG_FILE"
exit "$STATUS"
