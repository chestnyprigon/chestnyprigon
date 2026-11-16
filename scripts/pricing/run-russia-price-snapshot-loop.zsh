#!/bin/zsh
set -u
umask 077

PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
PROJECT_ROOT="${CHESTNY_PRIGON_PROJECT_DIR:-/Users/koredigital/Developer/chestny-prigon}"
LOG_DIR="${HOME}/Library/Logs/chestny-prigon"
LOG_FILE="${LOG_DIR}/russia-price-refresh.log"
MAX_BATCHES="${RUSSIA_PRICE_MAX_BATCHES:-50}"
ENV_FILE="${RUSSIA_PRICE_ENV_FILE:-${HOME}/.config/chestny-prigon/russia-price-refresh.env}"

if [[ ! -r "$ENV_FILE" ]]; then
  print -r -- "Russian price refresh environment file is missing or unreadable"
  exit 78
fi
set -a
source "$ENV_FILE"
set +a

mkdir -p "$LOG_DIR" || exit 1
cd "$PROJECT_ROOT" || exit 1

for (( batch = 1; batch <= MAX_BATCHES; batch++ )); do
  started_at="$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"
  print -r -- "[$started_at] Starting Russian price refresh batch ${batch}/${MAX_BATCHES}" >> "$LOG_FILE"
  output="$(RUSSIA_PRICE_BATCH_SIZE="${RUSSIA_PRICE_BATCH_SIZE:-100}" \
    RUSSIA_PRICE_CONCURRENCY="${RUSSIA_PRICE_CONCURRENCY:-4}" \
    npm run pricing:refresh-russia 2>&1)"
  exit_code=$?
  summary="$(print -r -- "$output" | /usr/bin/grep -E '\{"processed"[[:space:]]*:|\{"job"[[:space:]]*:' | /usr/bin/tail -n 1)"
  if [[ -n "$summary" ]]; then
    print -r -- "$summary" >> "$LOG_FILE"
  else
    print -r -- '{"job":"russia-price-snapshot-refresh","status":"failed","errorCode":"MISSING_SUMMARY"}' >> "$LOG_FILE"
  fi
  finished_at="$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"
  if (( exit_code != 0 )); then
    print -r -- "[$finished_at] Refresh batch failed (exit=$exit_code); next scheduled retry will pick it up" >> "$LOG_FILE"
    exit "$exit_code"
  fi
  processed="$(print -r -- "$output" | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const lines = input.trim().split(/\r?\n/).reverse();
      for (const line of lines) {
        try {
          const summary = JSON.parse(line);
          if (Number.isInteger(summary.processed)) { process.stdout.write(String(summary.processed)); return; }
        } catch {}
      }
      process.exitCode = 1;
    });
  ')" || {
    print -r -- "[$finished_at] Refresh output had no machine-readable summary; next scheduled retry will inspect the queue" >> "$LOG_FILE"
    exit 1
  }
  if (( processed == 0 )); then
    print -r -- "[$finished_at] Queue drained; no due Russian price snapshots remain" >> "$LOG_FILE"
    exit 0
  fi
done

finished_at="$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"
print -r -- "[$finished_at] Reached batch safety limit (${MAX_BATCHES}); remaining queue will be picked up by the next scheduled run" >> "$LOG_FILE"
exit 75
