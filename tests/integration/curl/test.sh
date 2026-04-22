#!/usr/bin/env bash
# Exhaustive curl smoke tests for every documented endpoint at
# /docs/api/reference/. Designed to be exactly the copy-pasteable
# commands a developer would run after reading the docs, plus one
# negative case per endpoint.
#
# Fails the script on ANY unexpected status code. Uses only standard
# POSIX tools + jq (falls back to grep if jq isn't installed).

set -euo pipefail

BASE="${SUPRABENCH_API_BASE:?Need SUPRABENCH_API_BASE, e.g. https://<deployment>.convex.site}"
KEY="${SUPRABENCH_API_KEY:?Need SUPRABENCH_API_KEY}"
EXPORT_KEY="${SUPRABENCH_API_EXPORT_KEY:-$KEY}"

CURL_OPTS=(-sS --fail-with-body -H "authorization: Bearer $KEY")
CURL_EXPORT_OPTS=(-sS --fail-with-body -H "authorization: Bearer $EXPORT_KEY")

pass=0
fail=0

log_ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
log_fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }

assert_status() {
  # $1=label, $2=expected status, remaining=curl args
  local label="$1" expected="$2"
  shift 2
  local status
  status=$(curl -sS -o /tmp/sb_body.$$ -w '%{http_code}' "$@" || true)
  if [ "$status" = "$expected" ]; then
    log_ok "$label (HTTP $status)"
  else
    log_fail "$label — expected $expected got $status; body:"
    sed 's/^/      /' /tmp/sb_body.$$ | head -5
  fi
  rm -f /tmp/sb_body.$$
}

assert_json_field() {
  # $1=label, $2=jq-path (like '.[0].slug'), $3=predicate (optional "string" / "number" / "array"), remaining=curl args
  local label="$1" path="$2" kind="${3:-any}"
  shift 3
  local out
  out=$(curl "$@" 2>/dev/null) || { log_fail "$label (curl error)"; return; }
  if command -v jq >/dev/null 2>&1; then
    local val
    val=$(printf '%s' "$out" | jq -r "$path" 2>/dev/null || true)
    if [ -z "$val" ] || [ "$val" = "null" ]; then
      log_fail "$label — no value at $path; got: $(printf '%s' "$out" | head -c 200)"
      return
    fi
    case "$kind" in
      string)
        if [ -n "$val" ]; then log_ok "$label ($path=$val)"; else log_fail "$label"; fi
        ;;
      number)
        if printf '%s' "$val" | grep -qE '^-?[0-9]+(\.[0-9]+)?$'; then
          log_ok "$label ($path=$val)"
        else
          log_fail "$label — $path is not a number ($val)"
        fi
        ;;
      any|*)
        log_ok "$label ($path present)"
        ;;
    esac
  else
    # No jq — degrade to grep. Still useful.
    if printf '%s' "$out" | grep -q "\"$(basename "$path")\""; then
      log_ok "$label (fallback grep)"
    else
      log_fail "$label"
    fi
  fi
}

echo "── GET /v1/models ──"
assert_status    "list models OK"                      200 "${CURL_OPTS[@]}" "$BASE/v1/models"
assert_status    "list models ?limit=5 OK"             200 "${CURL_OPTS[@]}" "$BASE/v1/models?limit=5"
assert_status    "list models ?tag=nonexistent OK=empty array, still 200" \
                                                       200 "${CURL_OPTS[@]}" "$BASE/v1/models?tag=definitely-no-such-tag"
assert_json_field "field slug exists" '.[0].slug'     string "${CURL_OPTS[@]}" "$BASE/v1/models?limit=1"
assert_json_field "field supraScore is number" '.[0].supraScore' number "${CURL_OPTS[@]}" "$BASE/v1/models?limit=1"

echo "── GET /v1/models/{slug} ──"
first_slug=$(curl -sS -H "authorization: Bearer $KEY" "$BASE/v1/models?limit=1" \
              | (command -v jq >/dev/null && jq -r '.[0].slug' || grep -oE '"slug":"[^"]+"' | head -1 | cut -d'"' -f4))
assert_status    "model detail $first_slug"            200 "${CURL_OPTS[@]}" "$BASE/v1/models/$first_slug"
assert_status    "model detail unknown → 404"          404 "${CURL_OPTS[@]}" "$BASE/v1/models/this-slug-will-never-exist-99999"

echo "── GET /v1/benches ──"
assert_status    "list benches OK"                     200 "${CURL_OPTS[@]}" "$BASE/v1/benches"
assert_json_field "bench slug" '.[0].slug' string "${CURL_OPTS[@]}" "$BASE/v1/benches?limit=1"

echo "── GET /v1/tags ──"
assert_status    "list tags OK"                        200 "${CURL_OPTS[@]}" "$BASE/v1/tags"

echo "── GET /v1/best ──"
assert_status    "best requires tag → 400"             400 "${CURL_OPTS[@]}" "$BASE/v1/best"
assert_status    "best?tag=reasoning OK"               200 "${CURL_OPTS[@]}" "$BASE/v1/best?tag=reasoning"
assert_status    "best?tag=reasoning&limit=3 OK"       200 "${CURL_OPTS[@]}" "$BASE/v1/best?tag=reasoning&limit=3"

echo "── GET /v1/export.json ──"
# Whether 200 or 403 depends on the key's tier. We accept either — the
# test just confirms the endpoint ROUTES and produces a well-formed
# error payload on 403.
exp_status=$(curl -sS -o /tmp/sb_body.$$ -w '%{http_code}' \
  -H "authorization: Bearer $EXPORT_KEY" "$BASE/v1/export.json" || true)
if [ "$exp_status" = "200" ]; then
  log_ok "export.json OK (Pro+ or partner key) [HTTP $exp_status]"
elif [ "$exp_status" = "403" ]; then
  body=$(cat /tmp/sb_body.$$)
  if printf '%s' "$body" | grep -q '"code":"tier_forbidden"'; then
    log_ok "export.json correctly 403'd with tier_forbidden (starter key)"
  else
    log_fail "export.json got 403 but wrong error code: $body"
  fi
else
  log_fail "export.json unexpected status $exp_status"
fi
rm -f /tmp/sb_body.$$

echo "── Auth error paths ──"
assert_status    "missing token → 401"                 401 -sS -o /dev/null -w '%{http_code}' "$BASE/v1/models"
assert_status    "bad prefix → 401"                    401 -sS -o /dev/null -w '%{http_code}' -H "authorization: Bearer pk_test_nope" "$BASE/v1/models"
bogus_full="sb_live_$(printf '0%.0s' $(seq 1 64))"
assert_status    "unknown token → 401"                 401 -sS -o /dev/null -w '%{http_code}' -H "authorization: Bearer $bogus_full" "$BASE/v1/models"

echo "── OPTIONS CORS preflight ──"
assert_status    "OPTIONS /v1/models → 204"            204 -sS -o /dev/null -w '%{http_code}' -X OPTIONS "$BASE/v1/models"

echo
echo "── Result ──"
echo "passed: $pass"
echo "failed: $fail"
[ "$fail" -eq 0 ]
