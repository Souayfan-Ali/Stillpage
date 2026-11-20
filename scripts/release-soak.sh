#!/usr/bin/env bash
# Dry-run soak of the ruleset-release chain (P2-09 PARTIAL): for each upstream snapshot
# (one uAssets commit per line of <commits>: "<sha> <ISO time>"), build the rulesets from that commit, repack the
# previously "published" zip, run the eligibility gate (Chromium load included), publish through the
# recorded-contract fake, and write the ruleset-state files. Each published candidate is the next day's base;
# a day that stops (build verify, or a gate outcome other than publish) leaves the published version as it was,
# and the next day repacks that same base again, as the daily workflow would.
# Never contacts a store. Leaves lists/lists.lock.json and lists/ruleset-counts.json as it found them.
#   usage: scripts/release-soak.sh <base.zip> <commits.txt> <work dir>
set -euo pipefail

BASE_ZIP=$1 COMMITS=$2 WORK=$3
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
mkdir -p "$WORK"
cp lists/lists.lock.json "$WORK/lock.saved"
cp lists/ruleset-counts.json "$WORK/counts.saved"
restore() { cp "$WORK/lock.saved" lists/lists.lock.json; cp "$WORK/counts.saved" lists/ruleset-counts.json; }
trap restore EXIT

cp -r lists/ledger "$WORK/ledger"
base="$WORK/day0.zip"
cp "$BASE_ZIP" "$base"
npm run -s release -- record --zip "$base" --out "$WORK/published.record.json"
summary="$WORK/summary.tsv"
printf 'day\tcommit\tversion\toutcome\tpublish\tseconds\tload\n' > "$summary"

day=0
while read -r sha when; do
  day=$((day + 1))
  dir="$WORK/day$day"
  mkdir -p "$dir"
  start=$(date +%s)
  npm run -s lists:fetch -- --ref "uassets=$sha" > "$dir/fetch.log" 2>&1
  cp -r "$WORK/ledger" "$dir/ledger-before"
  if ! npm run -s lists:build -- --ledger-dir "$WORK/ledger" > "$dir/build.log" 2>&1; then
    cp -r dist/compiler "$dir/compiler-debug"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$day" "${sha:0:10}" "-" "build-failed" "no" "$(( $(date +%s) - start ))" "$(cut -d' ' -f1 /proc/loadavg)" >> "$summary"
    echo "day $day: lists:build failed (fail closed): $(tail -n 1 "$dir/build.log")"
    continue
  fi
  cp -r dist/compiler "$dir/compiler-debug"
  npm run -s release -- repack --base "$base" --snapshot "$when" --out "$dir" > "$dir/repack.log"
  zip=$(ls "$dir"/*-chrome.zip)
  prev=$(node -p "require('$WORK/published.record.json').version")
  npm run -s release -- status --fake-published "$prev" | sed -n 2p > "$dir/store-state.json"
  set +e
  npm run -s release -- gate --base "$base" --candidate "$zip" --record "$WORK/published.record.json" \
    --ledgers-before "$dir/ledger-before" --ledgers-after "$WORK/ledger" --store-state "$dir/store-state.json" > "$dir/verdict.json"
  code=$?
  set -e
  outcome=$(node -p "require('$dir/verdict.json').outcome")
  published=no
  if [ "$code" -eq 0 ]; then
    npm run -s release -- publish-ruleset --zip "$zip" --verdict "$dir/verdict.json" --fake-published "$prev" > "$dir/publish.log"
    tail -n 1 "$dir/publish.log" | grep -q '"kind":"live"' && published=yes
    npm run -s release -- state --candidate "$zip" --base-record "$WORK/published.record.json" \
      --ledger-dir "$WORK/ledger" --out "$dir/state" > /dev/null
  fi
  version=$(node -p "require('$dir/verdict.json').candidateVersion")
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$day" "${sha:0:10}" "$version" "$outcome" "$published" "$(( $(date +%s) - start ))" "$(cut -d' ' -f1 /proc/loadavg)" >> "$summary"
  if [ "$published" != yes ]; then echo "day $day: $outcome (fail closed; the published version stays)"; continue; fi
  npm run -s release -- record --zip "$zip" --out "$WORK/published.record.json"
  base=$zip
done < "$COMMITS"
column -t "$summary"
