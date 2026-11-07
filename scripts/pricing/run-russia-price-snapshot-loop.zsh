#!/bin/zsh
set -u

PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
PROJECT_ROOT="${CHESTNY_PRIGON_PROJECT_DIR:-/Users/koredigital/Developer/chestny-prigon}"

cd "$PROJECT_ROOT" || exit 1

while true; do
  RUSSIA_PRICE_BATCH_SIZE="${RUSSIA_PRICE_BATCH_SIZE:-100}" \
  RUSSIA_PRICE_CONCURRENCY="${RUSSIA_PRICE_CONCURRENCY:-4}" \
    npm run pricing:refresh-russia >/dev/null 2>&1 || true
  sleep 120
done
