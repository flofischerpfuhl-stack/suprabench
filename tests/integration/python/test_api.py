"""End-to-end tests of the public HTTP API, driven by `requests`.

Mirrors the Python snippets in /docs/api/quickstart.html as closely
as possible — if a user copies from the docs and hits our API, the
call below is essentially what they'll execute.
"""

import json as _json
import os
import time
import pytest
import requests


# ─── /v1/models ──────────────────────────────────────────────────


def test_list_models_basic_shape(session, base):
    r = session.get(f"{base}/v1/models", timeout=10)
    assert r.status_code == 200, r.text
    assert "application/json" in r.headers["content-type"]
    data = r.json()
    assert isinstance(data, list)
    if data:
        m = data[0]
        for field in ("slug", "name", "provider", "supraScore", "tags"):
            assert field in m, f"missing {field} in model payload"
        assert isinstance(m["supraScore"], (int, float))


def test_list_models_limit_clamped_to_500(session, base):
    r = session.get(f"{base}/v1/models", params={"limit": 99999}, timeout=10)
    assert r.status_code == 200
    assert len(r.json()) <= 500


def test_list_models_limit_clamped_to_1(session, base):
    r = session.get(f"{base}/v1/models", params={"limit": 0}, timeout=10)
    assert r.status_code == 200
    # 0 → clamped to 1 per the docs; empty dataset still yields [].
    assert len(r.json()) <= 1


def test_list_models_unknown_tag_returns_empty_array(session, base):
    r = session.get(
        f"{base}/v1/models",
        params={"tag": "nobody-has-this-tag-xxxxxx"},
        timeout=10,
    )
    assert r.status_code == 200
    assert r.json() == []


def test_list_models_cache_headers(session, base):
    r = session.get(f"{base}/v1/models", timeout=10)
    cc = r.headers.get("cache-control", "")
    # 5-minute cache per docs/api-roadmap.md
    assert "max-age=300" in cc or "no-store" in cc


# ─── /v1/models/{slug} ───────────────────────────────────────────


def test_model_detail_ok(session, base, first_slug):
    r = session.get(f"{base}/v1/models/{first_slug}", timeout=10)
    assert r.status_code == 200
    m = r.json()
    assert m["slug"] == first_slug
    assert "scores" in m or "rank" in m  # shape per docs


def test_model_detail_unknown_slug_is_404(session, base):
    r = session.get(f"{base}/v1/models/this-slug-does-not-exist-xxx", timeout=10)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"


# ─── /v1/benches ─────────────────────────────────────────────────


def test_list_benches_ok(session, base):
    r = session.get(f"{base}/v1/benches", timeout=10)
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    if data:
        assert "slug" in data[0]


# ─── /v1/tags ────────────────────────────────────────────────────


def test_list_tags_ok(session, base):
    r = session.get(f"{base}/v1/tags", timeout=10)
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)


# ─── /v1/best ────────────────────────────────────────────────────


def test_best_requires_tag(session, base):
    r = session.get(f"{base}/v1/best", timeout=10)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "bad_request"


def test_best_with_tag_ok(session, base):
    r = session.get(f"{base}/v1/best", params={"tag": "reasoning", "limit": 3}, timeout=10)
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    assert len(data) <= 3


# ─── /v1/export.json ─────────────────────────────────────────────


def test_export_tier_gate(base, key, export_key):
    """
    If the caller ran with SUPRABENCH_API_EXPORT_KEY (Pro+ or partner),
    /v1/export.json MUST succeed. Otherwise the Starter key MUST get
    a `tier_forbidden` 403 — that's the documented contract.
    """
    token = export_key or key
    tier_is_gated = export_key == "" or export_key == key
    r = requests.get(
        f"{base}/v1/export.json",
        headers={"authorization": f"Bearer {token}"},
        timeout=30,
    )
    if tier_is_gated:
        # The key *might* be Pro+ (we just didn't set the override). We
        # accept 200 (if lucky) OR a documented 403.
        if r.status_code == 403:
            assert r.json()["error"]["code"] == "tier_forbidden"
        else:
            assert r.status_code == 200, r.text
    else:
        assert r.status_code == 200, r.text
        assert "application/json" in r.headers["content-type"]


# ─── Auth error surface ──────────────────────────────────────────


def test_missing_token_is_401(base):
    r = requests.get(f"{base}/v1/models", timeout=10)
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "missing_token"


def test_malformed_prefix_is_401(base):
    r = requests.get(
        f"{base}/v1/models",
        headers={"authorization": "Bearer pk_wrong_prefix"},
        timeout=10,
    )
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "invalid_token"


def test_unknown_token_is_401(base):
    bogus = "sb_live_" + ("0" * 64)
    r = requests.get(
        f"{base}/v1/models",
        headers={"authorization": f"Bearer {bogus}"},
        timeout=10,
    )
    assert r.status_code == 401
    assert r.json()["error"]["code"] in ("invalid_token",)


# ─── CORS / OPTIONS ──────────────────────────────────────────────


def test_options_preflight(base):
    r = requests.options(f"{base}/v1/models", timeout=10)
    assert r.status_code == 204
    assert r.headers.get("access-control-allow-origin") == "*"


# ─── Rate-limit smoke test (opt-in, slow) ────────────────────────


@pytest.mark.skipif(
    os.environ.get("SUPRABENCH_API_SKIP_RATE_LIMIT", "true").lower() in ("1", "true", "yes"),
    reason="rate-limit test eats quota; set SUPRABENCH_API_SKIP_RATE_LIMIT=false to enable",
)
def test_rate_limit_eventually_trips(session, base):
    trips = 0
    for _ in range(400):
        r = session.get(f"{base}/v1/models", params={"limit": 1}, timeout=5)
        if r.status_code == 429:
            assert r.json()["error"]["code"] in ("rate_limited", "quota_exceeded")
            # Documented header per docs/api-roadmap.md
            assert "retry-after" in {k.lower() for k in r.headers}
            trips += 1
            break
    assert trips >= 1, "never hit 429 in 400 requests — rate limiter misconfigured?"
