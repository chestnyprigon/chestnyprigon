#!/bin/zsh
set -u
umask 077

PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
PROJECT_ROOT="${CHESTNY_PRIGON_PROJECT_DIR:-/Users/koredigital/Developer/chestny-prigon}"
LOG_DIR="${HOME}/Library/Logs/chestny-prigon"
LOG_FILE="${LOG_DIR}/russia-price-refresh.log"
INTERVAL_SECONDS="${RUSSIA_PRICE_LOOP_INTERVAL_SECONDS:-120}"

mkdir -p "$LOG_DIR" || exit 1
cd "$PROJECT_ROOT" || exit 1

while true; do
  started_at="$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"
  print -r -- "[$started_at] Starting Russian price refresh" >> "$LOG_FILE"
  RUSSIA_PRICE_BATCH_SIZE="${RUSSIA_PRICE_BATCH_SIZE:-100}" \
  RUSSIA_PRICE_CONCURRENCY="${RUSSIA_PRICE_CONCURRENCY:-4}" \
    npm run pricing:refresh-russia >> "$LOG_FILE" 2>&1
  exit_code=$?
  finished_at="$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"
  if (( exit_code == 0 )); then
    print -r -- "[$finished_at] Refresh finished successfully (exit=$exit_code)" >> "$LOG_FILE"
  else
    print -r -- "[$finished_at] Refresh failed (exit=$exit_code); next retry in ${INTERVAL_SECONDS}s" >> "$LOG_FILE"
  fi
  sleep "$INTERVAL_SECONDS"
done
