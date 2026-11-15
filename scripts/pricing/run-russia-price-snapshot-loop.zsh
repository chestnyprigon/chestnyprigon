#!/bin/zsh
set -u
umask 077

PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
PROJECT_ROOT="${CHESTNY_PRIGON_PROJECT_DIR:-/Users/koredigital/Developer/chestny-prigon}"
LOG_DIR="${HOME}/Library/Logs/chestny-prigon"
LOG_FILE="${LOG_DIR}/russia-price-refresh.log"
MAX_BATCHES="${RUSSIA_PRICE_MAX_BATCHES:-50}"

mkdir -p "$LOG_DIR" || exit 1
cd "$PROJECT_ROOT" || exit 1

for (( batch = 1; batch <= MAX_BATCHES; batch++ )); do
  started_at="$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"
  print -r -- "[$started_at] Starting Russian price refresh batch ${batch}/${MAX_BATCHES}" >> "$LOG_FILE"
  output="$(RUSSIA_PRICE_BATCH_SIZE="${RUSSIA_PRICE_BATCH_SIZE:-100}" \
    RUSSIA_PRICE_CONCURRENCY="${RUSSIA_PRICE_CONCURRENCY:-4}" \
    npm run pricing:refresh-russia 2>&1)"
  exit_code=$?
  print -r -- "$output" >> "$LOG_FILE"
  finished_at="$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"
  if (( exit_code != 0 )); then
    print -r -- "[$finished_at] Refresh batch failed (exit=$exit_code); next scheduled retry will pick it up" >> "$LOG_FILE"
    print -r -- "$output"
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
    print -r -- "$output"
    exit 1
  }
  if (( processed == 0 )); then
    print -r -- "[$finished_at] Queue drained; no due Russian price snapshots remain" >> "$LOG_FILE"
    print -r -- "$output"
    exit 0
  fi
done

finished_at="$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"
print -r -- "[$finished_at] Reached batch safety limit (${MAX_BATCHES}); remaining queue will be picked up by the next scheduled run" >> "$LOG_FILE"
exit 75
