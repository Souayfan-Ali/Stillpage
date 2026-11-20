#!/usr/bin/env bash
# Incident rehearsal, dry run (P2-51, update-strategy notes §8 "A bad R release (mass breakage): re-run R from the previous
# lock (roll forward to old rules)"). With the real release tooling and the recorded-contract fake store:
#   G  a good ruleset release is published;
#   B  a bad one follows: one eligible safe rule blocks a major site's main_frame (it passes the gate);
#      the breakage is confirmed in Chromium (testMatchOutcome);
#   R  roll forward: rulesets rebuilt from G's lock with the current ledger (ids never reused), the live B
#      repacked into R (a higher version), gated, published, the site confirmed working again.
# Every step is timed. Never contacts a store; leaves lists/ as it found them.
#   usage: scripts/incident-rehearsal.sh <base.zip> <work dir> [<site url>]
set -euo pipefail

BASE_ZIP=$1 WORK=$2 SITE=${3:-https://en.wikipedia.org/}
SITE_HOST=$(node -p "new URL('$SITE').hostname")
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
mkdir -p "$WORK"
cp lists/lists.lock.json "$WORK/lock.saved"
cp lists/ruleset-counts.json "$WORK/counts.saved"
trap 'cp "$WORK/lock.saved" lists/lists.lock.json; cp "$WORK/counts.saved" lists/ruleset-counts.json' EXIT
cp -r lists/ledger "$WORK/ledger"
TIMES="$WORK/timings.tsv"
printf 'step\tms\n' > "$TIMES"
now_ms() { date +%s%3N; }
step() { local name=$1; shift; local t0; t0=$(now_ms); "$@"; printf '%s\t%s\n' "$name" "$(( $(now_ms) - t0 ))" >> "$TIMES"; }
iso() { date -u -d "$1" +%Y-%m-%dT%H:%M:%SZ; }
only_zip() { set -- "$1"/*-chrome.zip; [ "$#" -eq 1 ] && [ -f "$1" ] || { echo "expected one zip in ${1%/*}" >&2; exit 1; }; echo "$1"; }

# release <name> <base zip> <rulesets dir> <snapshot> — repack, gate, fake publish, state; prints the candidate zip.
release() {
  local name=$1 base=$2 rules=$3 snap=$4 dir="$WORK/$1"
  mkdir -p "$dir"
  local live; live=$(node -p "require('$WORK/published.record.json').version")
  step "$name: repack" npm run -s release -- repack --base "$base" --rulesets-dir "$rules" --snapshot "$snap" --out "$dir" > "$dir/repack.log"
  local zip; zip=$(only_zip "$dir")
  npm run -s release -- status --fake-published "$live" | sed -n 2p > "$dir/store-state.json"
  step "$name: gate (E1–E11, Chromium load)" npm run -s release -- gate --base "$base" --candidate "$zip" --record "$WORK/published.record.json" \
    --ledgers-before "$WORK/ledger-before-$name" --ledgers-after "$WORK/ledger" --store-state "$dir/store-state.json" > "$dir/verdict.json"
  step "$name: publish (fake store, skip review)" npm run -s release -- publish-ruleset --zip "$zip" --verdict "$dir/verdict.json" --fake-published "$live" > "$dir/publish.log"
  tail -n 1 "$dir/publish.log" | grep -q '"kind":"live"'
  step "$name: ruleset-state" npm run -s release -- state --candidate "$zip" --base-record "$WORK/published.record.json" --ledger-dir "$WORK/ledger" --out "$dir/state" > /dev/null
  npm run -s release -- record --zip "$zip" --out "$WORK/published.record.json"
}

site() { npm run -s release -- match --zip "$1" --url "$SITE" | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).outcome"; }

npm run -s release -- record --zip "$BASE_ZIP" --out "$WORK/published.record.json"

# G: a good release from the locked lists.
cp -r "$WORK/ledger" "$WORK/ledger-before-G"
step "G: lists:build" npm run -s lists:build -- --ledger-dir "$WORK/ledger" > "$WORK/G-build.log" 2>&1
release G "$BASE_ZIP" public "$(iso '-3 min')"
G_ZIP=$(only_zip "$WORK/G")
echo "G $(node -p "require('$WORK/published.record.json').version") published; $SITE_HOST: $(site "$G_ZIP")"

# B: a bad but eligible release — one safe block rule on the site's documents, with a ledger id of its own.
cp -r "$WORK/ledger" "$WORK/ledger-before-B"
mkdir -p "$WORK/B-rules"
npm run -s release -- drill-bad-rule --zip "$G_ZIP" --out "$WORK/B-rules" --ledger "$WORK/ledger/ubo.json" --host "$SITE_HOST"
release B "$G_ZIP" "$WORK/B-rules" "$(iso '-2 min')"
B_ZIP=$(only_zip "$WORK/B")
B_SITE=$(site "$B_ZIP")
echo "B $(node -p "require('$WORK/published.record.json').version") published; $SITE_HOST: $B_SITE"
[ "$B_SITE" = blocked ] || { echo "rehearsal set-up failed: B does not break $SITE_HOST" >&2; exit 1; }

# Incident detected. R: roll forward from G's lock.
detected=$(now_ms)
cp -r "$WORK/ledger" "$WORK/ledger-before-R"
step "R: restore G's lock" cp "$WORK/G/state/ruleset-state/lists.lock.json" lists/lists.lock.json
step "R: lists:fetch (locked, offline)" npm run -s lists:fetch -- --offline > "$WORK/R-fetch.log"
step "R: lists:build" npm run -s lists:build -- --ledger-dir "$WORK/ledger" > "$WORK/R-build.log" 2>&1
release R "$B_ZIP" public "$(iso 'now')"
R_ZIP=$(only_zip "$WORK/R")
R_SITE=$(site "$R_ZIP")
printf 'detected → R live (roll-forward total)\t%s\n' "$(( $(now_ms) - detected ))" >> "$TIMES"
echo "R $(node -p "require('$WORK/published.record.json').version") published; $SITE_HOST: $R_SITE"
[ "$R_SITE" = allowed ] || { echo "roll-forward did not repair $SITE_HOST" >&2; exit 1; }
column -t -s $'\t' "$TIMES"
