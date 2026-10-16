#!/usr/bin/env bash
set -euo pipefail

REPO="/Users/koreakim/Developer/chestny-prigon"
cd "$REPO"

STAMP="20261008"
PLAN="output/local-live-20261009-brand-quotas.json"
PREPARE="output/local-live-${STAMP}-prepare.json"
SEARCH_LOG="output/local-live-${STAMP}-search.log"
PREFLIGHT="output/local-live-${STAMP}-preflight.json"
WORKER_LOG="output/local-live-${STAMP}-worker.log"

# Keep credentials local to this process, force direct Encar traffic, and avoid
# inheriting the separate catalog-launch experiment from the shell environment.
export CHESTNY_CATALOG_LAUNCH_ID=""
export ENCAR_PROXY_URL=""
export HTTP_PROXY=""
export HTTPS_PROXY=""
export ALL_PROXY=""

printf '%s\n' "phase=live_candidate_search transport=direct started_at=$(date -u +%FT%TZ)"
node_modules/.bin/tsx scripts/radar/prepare-vps-live-queue.ts \
  --direct --target=4000 --overscan=4 --page-size=500 --year-from=2016 \
  --max-mileage=190000 --brand-quotas="$PLAN" >"$PREPARE" 2>"$SEARCH_LOG"

RUN_ID="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).runId)' "$PREPARE")"
if [[ ! "$RUN_ID" =~ ^[0-9a-fA-F-]{36}$ ]]; then
  printf '%s\n' "invalid_run_id=$RUN_ID"
  exit 1
fi
printf '%s\n' "phase=queue_created run_id=$RUN_ID prepare_report=$PREPARE"

node_modules/.bin/tsx scripts/radar/preflight-local-worker.ts --run-id="$RUN_ID" --transport=direct >"$PREFLIGHT" 2>&1
printf '%s\n' "phase=enrichment_started run_id=$RUN_ID"
node_modules/.bin/tsx scripts/radar/run-local-enrichment-loop.ts --run-id="$RUN_ID" --transport=direct --until-complete >"$WORKER_LOG" 2>&1

printf '%s\n' "phase=screening_started run_id=$RUN_ID"
CHESTNY_ENRICHMENT_RUN_ID="$RUN_ID" \
CHESTNY_PUBLICATION_OUTPUT_PATH="output/chestny-vps-publication-ready-${RUN_ID}.json" \
  node_modules/.bin/tsx scripts/radar/screen-vps-staging.ts >"output/local-live-${STAMP}-screening.json" 2>&1

printf '%s\n' "phase=price_audit_started run_id=$RUN_ID"
CHESTNY_ENRICHMENT_RUN_ID="$RUN_ID" \
  node_modules/.bin/tsx scripts/radar/audit-staging-prices.ts \
    --publication-report="output/chestny-vps-publication-ready-${RUN_ID}.json" \
    >"output/local-live-${STAMP}-price-audit.log" 2>&1

printf '%s\n' "phase=ready_for_review run_id=$RUN_ID report=output/chestny-vps-publication-ready-${RUN_ID}.json"
