#!/usr/bin/env bash
# Installs pinned, checksum-verified CLI tools (actionlint, gitleaks) into .cache/tools/bin.
# Linux x64 only for now; CI uses the same pins. Downloads go to the git-ignored cache.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="$ROOT/.cache/tools"
DL="$TOOLS/dl"
BIN="$TOOLS/bin"

ACTIONLINT_VERSION="1.7.12"
ACTIONLINT_SHA256="8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
GITLEAKS_VERSION="8.30.1"
GITLEAKS_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"

if [[ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]]; then
  echo "install-tools: only Linux x86_64 is pinned; install actionlint and gitleaks yourself." >&2
  exit 1
fi

mkdir -p "$DL" "$BIN"

# fetch <url> <file> <sha256> <binary-name>
fetch() {
  local url="$1" file="$2" sha="$3" name="$4"
  if [[ ! -f "$DL/$file" ]] || ! echo "$sha  $DL/$file" | sha256sum -c --quiet - 2>/dev/null; then
    curl -fsSL --proto '=https' --tlsv1.2 -o "$DL/$file" "$url"
  fi
  echo "$sha  $DL/$file" | sha256sum -c --quiet -
  tar -xzf "$DL/$file" -C "$BIN" "$name"
  chmod 0755 "$BIN/$name"
}

fetch "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz" \
  "actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz" "$ACTIONLINT_SHA256" actionlint
fetch "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
  "gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" "$GITLEAKS_SHA256" gitleaks

"$BIN/actionlint" -version | head -1
"$BIN/gitleaks" version
