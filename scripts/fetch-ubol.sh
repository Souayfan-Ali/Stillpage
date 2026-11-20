#!/usr/bin/env bash
# Downloads the pinned uBO Lite release into .cache/spikes/ubol (git-ignored). It is the oracle of the
# differential suite (tests/dnr) and a benchmark configuration; never an input to our build.
# UBOL_VERSION must equal "ubol" in lists/oracle/ubol.json (checked by tests/unit/ci/workflows.test.ts).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/.cache/spikes/ubol"
UBOL_VERSION="2026.1110.1816"
UBOL_SHA256="85fe5909366e8ada66c5b331bbdbf69cf5100245ed6161b1e4e2f1f848ec7d03"
FILE="uBOLite_${UBOL_VERSION}.chromium.zip"
URL="https://github.com/uBlockOrigin/uBOL-home/releases/download/${UBOL_VERSION}/${FILE}"

mkdir -p "$DIR/unpacked"
if [[ ! -f "$DIR/$FILE" ]] || ! echo "$UBOL_SHA256  $DIR/$FILE" | sha256sum -c --quiet - 2>/dev/null; then
  curl -fsSL --proto '=https' --tlsv1.2 -o "$DIR/$FILE" "$URL"
fi
echo "$UBOL_SHA256  $DIR/$FILE" | sha256sum -c --quiet -
unzip -q -o "$DIR/$FILE" -d "$DIR/unpacked"
echo "uBOL $UBOL_VERSION ready in $DIR/unpacked"
