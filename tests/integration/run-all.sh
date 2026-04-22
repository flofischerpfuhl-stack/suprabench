#!/usr/bin/env bash
# Run every language's end-to-end suite in sequence against whatever
# deployment SUPRABENCH_API_BASE points at. Fails fast on the first
# red suite.
#
# Usage:
#   export SUPRABENCH_API_BASE=https://<deployment>.convex.site
#   export SUPRABENCH_API_KEY=sb_live_xxxxxxxxxxxx
#   # optional:
#   # export SUPRABENCH_API_EXPORT_KEY=sb_live_proxxxxxxxx
#   # export SUPRABENCH_API_SKIP_RATE_LIMIT=false
#   bash tests/integration/run-all.sh
#
# Skips a language suite (with a clear note) if the required toolchain
# isn't installed — so running on a minimal CI node still exercises
# everything it *can*.

set -euo pipefail

: "${SUPRABENCH_API_BASE:?set SUPRABENCH_API_BASE}"
: "${SUPRABENCH_API_KEY:?set SUPRABENCH_API_KEY}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

have() { command -v "$1" >/dev/null 2>&1; }

section() { printf '\n\033[1m═══ %s ═══\033[0m\n' "$1"; }

section "curl"
if have curl; then
  bash curl/test.sh
else
  echo "  (skipped — curl not installed)"
fi

section "Python (pytest)"
if have python3 && have pip; then
  if ! python3 -c "import pytest, requests" 2>/dev/null; then
    echo "  installing python deps to a venv under tests/integration/python/.venv..."
    python3 -m venv python/.venv
    python/.venv/bin/pip install -q -r python/requirements.txt
    PYTHON="python/.venv/bin/python"
  else
    PYTHON="python3"
  fi
  "$PYTHON" -m pytest python -v
else
  echo "  (skipped — python3 not installed)"
fi

section "JavaScript (node:test)"
if have node; then
  node_version="$(node -v | sed 's/v//' | cut -d. -f1)"
  if [ "$node_version" -lt 20 ]; then
    echo "  (skipped — Node ≥ 20 required, got v$node_version — uses global fetch)"
  else
    (cd javascript && node --test --test-reporter=spec test.mjs)
  fi
else
  echo "  (skipped — node not installed)"
fi

section "Go"
if have go; then
  (cd go && go test -v ./...)
else
  echo "  (skipped — go not installed)"
fi

echo
echo "All installed language suites passed."
