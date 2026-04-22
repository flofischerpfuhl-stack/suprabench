"""Shared fixtures + env-var enforcement.

Keeps every test file tiny and lets us switch between a prod deployment
and a local `npx convex dev` deployment with zero code change.
"""

import os
import time
import pytest
import requests


@pytest.fixture(scope="session")
def base() -> str:
    v = os.environ.get("SUPRABENCH_API_BASE")
    if not v:
        pytest.skip("SUPRABENCH_API_BASE not set")
    return v.rstrip("/")


@pytest.fixture(scope="session")
def key() -> str:
    v = os.environ.get("SUPRABENCH_API_KEY")
    if not v:
        pytest.skip("SUPRABENCH_API_KEY not set")
    return v


@pytest.fixture(scope="session")
def export_key() -> str:
    # Optional. Many test runs only have a starter key; in that case
    # we assert tier_forbidden on /v1/export.json. If you have a Pro+
    # or partner key, export tests assert 200 shape instead.
    return os.environ.get("SUPRABENCH_API_EXPORT_KEY", "")


@pytest.fixture(scope="session")
def session(key) -> requests.Session:
    s = requests.Session()
    s.headers.update({"authorization": f"Bearer {key}"})
    return s


@pytest.fixture(scope="session")
def first_slug(session, base) -> str:
    r = session.get(f"{base}/v1/models", params={"limit": 1}, timeout=10)
    r.raise_for_status()
    arr = r.json()
    if not arr:
        pytest.skip("deployment has no ranked models yet")
    return arr[0]["slug"]


@pytest.fixture
def timed():
    # Yields a helper that prints per-test HTTP timings; handy for smoke
    # tests after a deploy ("did latency regress?").
    t0 = time.monotonic()
    yield
    dt = (time.monotonic() - t0) * 1000
    # Keep quiet under -q; show under -v.
    print(f"  [{dt:6.0f} ms]")
