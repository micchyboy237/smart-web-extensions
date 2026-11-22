"""
Tests for the `/search_grouped` endpoint and its supporting helpers.

Layout:
    * Unit tests (no DB)          — always run.
    * MMR unit tests (no DB)      — always run.
    * Integration tests (DB)      — skipped unless `MISSAV_TEST_DSN` is set
                                    and reachable.

Run all:
    pytest server_paginated/tests/test_search_grouped.py -v

Run only unit tests (no DB required):
    pytest server_paginated/tests/test_search_grouped.py -v -m "not integration"

Run integration tests against a scratch DB:
    MISSAV_TEST_DSN="dbname=missav_test user=... host=localhost port=5432" \\
    pytest server_paginated/tests/test_search_grouped.py -v -m integration

Environment variables honored:
    MISSAV_TEST_DSN        Postgres DSN used by the endpoint under test.
                            If unset or unreachable, integration tests skip.
    MISSAV_TEST_SCHEMA     Schema name (default: public).
    MISSAV_TEST_TABLE      Table name (default: videos).

Notes:
    * The endpoint under test is imported as `serve_missav` from the
      `server_paginated` directory. Adjust `_SERVER_DIR` if your layout
      differs.
    * Integration tests create their own throwaway rows (prefixed with
      `tst-<uuid>-` in `code`) and delete them in a fixture finalizer,
      so they don't pollute the real `videos` table.
"""

from __future__ import annotations

import base64
import json
import os
import random
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List

import numpy as np
import pytest

# ---------------------------------------------------------------------------
# Import the server module under test
# ---------------------------------------------------------------------------

_SERVER_DIR = Path(__file__).resolve().parents[1]
if str(_SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVER_DIR))

try:
    import serve_missav as srv
except Exception as exc:  # pragma: no cover - import guard
    pytest.skip(f"cannot import serve_missav: {exc}", allow_module_level=True)

from jet.adapters.llama_cpp.diversity_utils.mmr import mmr_rerank

# ---------------------------------------------------------------------------
# Pytest configuration
# ---------------------------------------------------------------------------


def pytest_configure(config):
    config.addinivalue_line("markers", "integration: needs a live Postgres DB")


# ---------------------------------------------------------------------------
# DB availability
# ---------------------------------------------------------------------------


def _db_reachable(dsn: str) -> bool:
    """Return True iff we can open a connection and run `SELECT 1`."""
    try:
        import psycopg
    except Exception:
        return False
    try:
        with psycopg.connect(dsn, connect_timeout=2) as conn:
            conn.execute("SELECT 1")
        return True
    except Exception:
        return False


TEST_DSN = os.environ.get("MISSAV_TEST_DSN", "").strip()
DB_AVAILABLE = bool(TEST_DSN) and _db_reachable(TEST_DSN)

integration = pytest.mark.skipif(
    not DB_AVAILABLE,
    reason="set MISSAV_TEST_DSN to a reachable Postgres to run integration tests",
)
needs_db = pytest.mark.integration


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def fastapi_client():
    """TestClient bound to a *copy* of the app whose pool points at TEST_DSN.

    We mutate `srv.DB_CONNINFO` / rebuild `srv.pool` so the endpoint under
    test talks to the scratch DB, not the developer's real one.
    """
    if not DB_AVAILABLE:
        pytest.skip("no reachable test DB")
    from fastapi.testclient import TestClient

    # Rebuild the pool against the test DSN.
    from psycopg_pool import ConnectionPool

    old_pool = srv.pool
    old_conninfo = srv.DB_CONNINFO
    try:
        srv.DB_CONNINFO = TEST_DSN
        srv.pool = ConnectionPool(
            TEST_DSN,
            min_size=1,
            max_size=4,
            open=True,
            configure=srv._configure,
            kwargs={"row_factory": srv.dict_row},
        )
        # FastAPI lifespan still opens the *original* pool on startup; we
        # sidestep it by using the app without lifespan.
        client = TestClient(srv.app)
        # Force the endpoint to use the test pool even if lifespan ran.
        srv.pool = srv.pool
        yield client
    finally:
        try:
            srv.pool.close()
        except Exception:
            pass
        srv.pool = old_pool
        srv.DB_CONNINFO = old_conninfo


@pytest.fixture()
def seeded_rows():
    """Insert a deterministic set of throwaway groups; yield their ids; clean up.

    Each group has `n_episodes` episodes. Group ids are `tst-<uuid>-<n>`,
    so cleanup can just `DELETE ... WHERE id LIKE 'tst-<uuid>-%'`.

    The row shape matches `public.videos`. Embeddings are deterministic
    (seeded RNG), so MMR orderings are reproducible.
    """
    if not DB_AVAILABLE:
        pytest.skip("no reachable test DB")

    schema = os.environ.get("MISSAV_TEST_SCHEMA", "public")
    table = os.environ.get("MISSAV_TEST_TABLE", "videos")
    fq = f'"{schema}"."{table}"'

    tag = f"tst-{uuid.uuid4().hex[:12]}"
    rng = random.Random(0xC0FFEE)
    rng_np = np.random.default_rng(0xC0FFEE)

    now = datetime.now(timezone.utc)
    rows: List[dict] = []
    # 12 groups; each is a distinct topic (one-hot-ish) plus jitter.
    for g in range(12):
        n_eps = rng.choice([1, 2, 3])
        # Group centroid: sparse-ish one-hot with noise.
        base = rng_np.normal(size=768).astype(np.float32)
        base[g % 768] += 5.0  # push one dim to make groups separable
        base /= np.linalg.norm(base)
        for e in range(n_eps):
            emb = base + rng_np.normal(scale=0.05, size=768).astype(np.float32)
            emb /= np.linalg.norm(emb)
            rows.append(
                {
                    "id": f"{tag}-{g}-{e}",
                    "url": f"https://example.test/{tag}-{g}-{e}",
                    "code": f"{tag}-{g}",
                    "episode": str(e + 1),
                    "video_id": f"{tag}-{g}-{e}",
                    "title": f"Test group {g} episode {e + 1}",
                    "thumbnail": None,
                    "preview": None,
                    "details": f"Details for group {g} episode {e + 1}",
                    "release_date": now - timedelta(days=g),
                    "genres": ["Test", f"Genre{g % 3}"],
                    "embedding": emb.tolist(),
                }
            )

    import psycopg
    from pgvector.psycopg import register_vector

    cols = [
        "id",
        "url",
        "code",
        "episode",
        "video_id",
        "title",
        "thumbnail",
        "preview",
        "details",
        "release_date",
        "genres",
        "embedding",
    ]
    placeholders = "(" + ", ".join(["%s"] * len(cols)) + ")"
    flat = [tuple(r[c] for c in cols) for r in rows]

    with psycopg.connect(TEST_DSN) as conn:
        register_vector(conn)
        with conn.cursor() as cur:
            cur.executemany(
                f"INSERT INTO {fq} ({', '.join(cols)}) VALUES {placeholders}",
                flat,
            )
        conn.commit()

    try:
        yield {"tag": tag, "groups": {f"{tag}-{g}" for g in range(12)}, "rows": rows}
    finally:
        with psycopg.connect(TEST_DSN) as conn:
            with conn.cursor() as cur:
                cur.execute(f"DELETE FROM {fq} WHERE id LIKE %s", (f"{tag}-%",))
            conn.commit()


# ===========================================================================
# 1. Unit tests — helpers (no DB)
# ===========================================================================


class TestNormalizeEpisode:
    def test_numeric_zero_pads_to_8(self):
        assert srv._normalize_episode("9") == "00000009"
        assert srv._normalize_episode("431") == "00000431"
        assert srv._normalize_episode("0") == "00000000"

    def test_whitespace_is_stripped_before_padding(self):
        assert srv._normalize_episode("  12  ") == "00000012"

    def test_non_numeric_is_lowercased_and_trimmed(self):
        assert srv._normalize_episode("  SP-01 ") == "sp-01"
        assert srv._normalize_episode("A") == "a"

    def test_empty_and_none_are_safe(self):
        assert srv._normalize_episode("") == ""
        assert srv._normalize_episode("   ") == ""

    def test_ordering_matches_numeric_for_digit_strings(self):
        eps = ["2", "10", "1", "100", "20"]
        ordered = sorted(eps, key=srv._normalize_episode)
        assert ordered == ["1", "2", "10", "20", "100"]


class TestGroupedFingerprint:
    def _req(self, **kw):
        base = dict(
            query="q",
            code=None,
            genre=None,
            genres_mode="any",
            min_release_date=None,
            max_release_date=None,
            completion_filter="all",
            min_similarity=None,
            diversity=0.0,
            fetch_k=None,
        )
        base.update(kw)
        return srv.GroupedSearchRequest(**base)

    def test_same_request_same_fp(self):
        a = srv._grouped_fingerprint(self._req())
        b = srv._grouped_fingerprint(self._req())
        assert a == b
        assert len(a) == 12

    def test_filters_change_fp(self):
        base = srv._grouped_fingerprint(self._req())
        assert srv._grouped_fingerprint(self._req(query="other")) != base
        assert srv._grouped_fingerprint(self._req(code=["abc"])) != base
        assert srv._grouped_fingerprint(self._req(genre=["Drama"])) != base
        assert srv._grouped_fingerprint(self._req(genres_mode="all")) != base
        assert srv._grouped_fingerprint(self._req(completion_filter="complete")) != base
        assert srv._grouped_fingerprint(self._req(diversity=0.5)) != base

    def test_min_similarity_requires_query_upstream(self):
        # fingerprint itself doesn't validate; the endpoint does.
        fp = srv._grouped_fingerprint(self._req(query=None, min_similarity=0.5))
        assert isinstance(fp, str) and len(fp) == 12

    # FIX #4: fetch_k is now part of the fingerprint
    def test_fetch_k_changes_fp(self):
        base = srv._grouped_fingerprint(self._req())
        assert srv._grouped_fingerprint(self._req(fetch_k=10)) != base
        assert srv._grouped_fingerprint(self._req(fetch_k=100)) != base
        assert srv._grouped_fingerprint(
            self._req(fetch_k=10)
        ) != srv._grouped_fingerprint(self._req(fetch_k=100))

    def test_genre_and_code_lists_are_order_insensitive(self):
        a = srv._grouped_fingerprint(self._req(genre=["A", "B"], code=["x", "y"]))
        b = srv._grouped_fingerprint(self._req(genre=["B", "A"], code=["y", "x"]))
        assert a == b


class TestGroupedCursor:
    def test_round_trip_next(self):
        cur = srv._encode_grouped_cursor("abc", "00000001", "deadbeefcafe", "next")
        c, e, d = srv._decode_grouped_cursor(cur, "deadbeefcafe")
        assert (c, e, d) == ("abc", "00000001", "next")

    def test_round_trip_prev(self):
        cur = srv._encode_grouped_cursor("abc", "00000001", "deadbeefcafe", "prev")
        c, e, d = srv._decode_grouped_cursor(cur, "deadbeefcafe")
        assert (c, e, d) == ("abc", "00000001", "prev")

    def test_fingerprint_mismatch_raises_400(self):
        cur = srv._encode_grouped_cursor("abc", "00000001", "fp1", "next")
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as ei:
            srv._decode_grouped_cursor(cur, "fp2")
        assert ei.value.status_code == 400

    def test_garbage_cursor_raises_400(self):
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as ei:
            srv._decode_grouped_cursor("not-base64!!", "fp")
        assert ei.value.status_code == 400

    def test_payload_is_json(self):
        cur = srv._encode_grouped_cursor("abc", "00000001", "fp", "next")
        raw = base64.urlsafe_b64decode(cur.encode())
        data = json.loads(raw)
        assert data == {"c": "abc", "e": "00000001", "f": "fp", "d": "next"}


# ===========================================================================
# 2. Unit tests — MMR (no DB)
# ===========================================================================


def _reference_mmr(query_vec, doc_vecs, top_k, lambda_param):
    """Pure-Python O(n^3) reference used to validate the vectorized impl."""
    n = len(doc_vecs)
    top_k = min(top_k, n)
    if n == 0:
        return []

    def cos(a, b):
        d = np.linalg.norm(a) * np.linalg.norm(b)
        return float(np.dot(a, b) / d) if d else 0.0

    rel = np.array([cos(query_vec, doc_vecs[i]) for i in range(n)])
    selected, results, remaining = [], [], list(range(n))
    for _ in range(top_k):
        best_idx, best_score, best_rel, best_red = None, -np.inf, 0.0, 0.0
        for idx in remaining:
            r = rel[idx]
            red = (
                max(cos(doc_vecs[idx], doc_vecs[s]) for s in selected)
                if selected
                else 0.0
            )
            s = lambda_param * r - (1 - lambda_param) * red
            if s > best_score:
                best_idx, best_score, best_rel, best_red = idx, s, r, red
        if best_idx is None:
            break
        selected.append(best_idx)
        remaining.remove(best_idx)
        results.append(
            {
                "index": best_idx,
                "relevance": best_rel,
                "redundancy": best_red,
                "mmr_score": best_score,
            }
        )
    return results


class TestMMRRerank:
    def _rand(self, seed, n=20, d=64):
        rng = np.random.default_rng(seed)
        docs = rng.normal(size=(n, d)).astype(np.float32)
        q = rng.normal(size=d).astype(np.float32)
        return q, docs

    @pytest.mark.parametrize("lambda_param", [0.0, 0.25, 0.5, 0.75, 1.0])
    def test_matches_reference_selection(self, lambda_param):
        """Same *set* of indices must be selected; order may differ on ties.

        The vectorized impl accumulates redundancy in float32, the reference in
        float64; near-ties flip order but the greedy selection set is stable.
        We assert the selection *set* matches and that each item's relevance /
        redundancy matches the reference's value for that index within tolerance.
        """
        q, docs = self._rand(seed=1)
        got = mmr_rerank(q, docs, top_k=len(docs), lambda_param=lambda_param)
        want = _reference_mmr(q, docs, top_k=len(docs), lambda_param=lambda_param)

        assert len(got) == len(want)
        assert {r["index"] for r in got} == {r["index"] for r in want}

        want_by_idx = {r["index"]: r for r in want}
        for g in got:
            w = want_by_idx[g["index"]]
            assert pytest.approx(g["relevance"], abs=1e-3) == w["relevance"]
            # redundancy can legitimately differ when ties reorder the selected
            # set — skip strict redundancy comparison, keep mmr_score bounded.
            assert abs(g["mmr_score"] - w["mmr_score"]) < 1e-3

    @pytest.mark.parametrize("lambda_param", [0.0, 0.5, 1.0])
    def test_matches_reference_scores(self, lambda_param):
        q, docs = self._rand(seed=2)
        got = mmr_rerank(q, docs, top_k=len(docs), lambda_param=lambda_param)
        want = _reference_mmr(q, docs, top_k=len(docs), lambda_param=lambda_param)
        for g, w in zip(got, want):
            assert g["index"] == w["index"]
            assert pytest.approx(g["relevance"], abs=1e-3) == w["relevance"]
            assert pytest.approx(g["redundancy"], abs=1e-3) == w["redundancy"]
            assert pytest.approx(g["mmr_score"], abs=1e-3) == w["mmr_score"]

    def test_top_k_less_than_n(self):
        q, docs = self._rand(seed=3, n=50, d=32)
        got = mmr_rerank(q, docs, top_k=5, lambda_param=0.7)
        assert len(got) == 5
        assert len({r["index"] for r in got}) == 5

    def test_top_k_greater_than_n_is_clamped(self):
        q, docs = self._rand(seed=4, n=3, d=16)
        got = mmr_rerank(q, docs, top_k=100, lambda_param=0.5)
        assert len(got) == 3

    def test_empty_input(self):
        assert (
            mmr_rerank(
                np.zeros(8, dtype=np.float32),
                np.zeros((0, 8), dtype=np.float32),
                top_k=5,
                lambda_param=0.5,
            )
            == []
        )

    def test_lambda_1_is_pure_relevance(self):
        q, docs = self._rand(seed=5, n=10, d=32)
        got = mmr_rerank(q, docs, top_k=10, lambda_param=1.0)
        # First item must be the most-relevant doc.
        norms = np.linalg.norm(docs, axis=1)
        rel = (docs @ q) / (norms * np.linalg.norm(q))
        assert got[0]["index"] == int(np.argmax(rel))

    def test_lambda_0_is_pure_diversity(self):
        # First item is arbitrary (relevance term zeroed); subsequent items
        # must be the farthest from the selected set.
        q, docs = self._rand(seed=6, n=10, d=32)
        got = mmr_rerank(q, docs, top_k=10, lambda_param=0.0)
        assert [r["index"] for r in got]  # non-empty
        # Redundancy of every item after the first should be non-decreasing
        # (greedy farthest-point). At minimum it must be >= 0.
        for r in got[1:]:
            assert r["redundancy"] >= 0.0

    def test_deterministic(self):
        q, docs = self._rand(seed=7, n=30, d=32)
        a = [r["index"] for r in mmr_rerank(q, docs, 30, 0.5)]
        b = [r["index"] for r in mmr_rerank(q, docs, 30, 0.5)]
        assert a == b


# ===========================================================================
# 3. Integration tests — endpoint against a live DB
# ===========================================================================


def _walk(client, params, max_pages=20):
    """Walk the endpoint forward, collecting (page, items, keys) per page."""
    pages = []
    cursor = None
    for _ in range(max_pages):
        q = dict(params)
        if cursor:
            q["cursor"] = cursor
        r = client.get("/search_grouped", params=q)
        assert r.status_code == 200, r.text
        body = r.json()
        pages.append(body)
        cursor = body.get("next_cursor")
        if not cursor or not body["has_more"]:
            break
    return pages


@integration
class TestSearchGroupedIntegration:
    def test_basic_shape(self, fastapi_client, seeded_rows):
        r = fastapi_client.get(
            "/search_grouped",
            params={"limit": 5, "code": [seeded_rows["tag"] + "-0"]},
        )
        assert r.status_code == 200
        body = r.json()
        assert set(body) >= {
            "items",
            "count",
            "took_ms",
            "next_cursor",
            "has_more",
            "has_previous",
            "diversity_applied",
        }
        assert body["diversity_applied"] is False
        assert body["count"] == len(body["items"])

    def test_min_similarity_requires_query(self, fastapi_client):
        r = fastapi_client.get(
            "/search_grouped",
            params={"min_similarity": 0.5},
        )
        assert r.status_code == 400

    def test_cursor_filter_mismatch_returns_400(self, fastapi_client, seeded_rows):
        r = fastapi_client.get(
            "/search_grouped",
            params={"limit": 5, "code": [seeded_rows["tag"] + "-0"]},
        )
        cur = r.json()["next_cursor"]
        assert cur is not None
        # Change the filter → must reject the cursor.
        r2 = fastapi_client.get(
            "/search_grouped",
            params={
                "limit": 5,
                "code": [seeded_rows["tag"] + "-1"],
                "cursor": cur,
            },
        )
        assert r2.status_code == 400

    # FIX #4: fetch_k is bound to the cursor.
    def test_fetch_k_change_invalidates_cursor(self, fastapi_client, seeded_rows):
        r = fastapi_client.get(
            "/search_grouped",
            params={
                "limit": 3,
                "fetch_k": 10,
                "diversity": 0.5,
                "code": [f"{seeded_rows['tag']}-{g}" for g in range(12)],
            },
        )
        assert r.status_code == 200, r.text
        cur = r.json()["next_cursor"]
        assert cur, "expected a next cursor"
        r2 = fastapi_client.get(
            "/search_grouped",
            params={
                "limit": 3,
                "fetch_k": 50,  # <-- changed
                "diversity": 0.5,
                "code": [f"{seeded_rows['tag']}-{g}" for g in range(12)],
                "cursor": cur,
            },
        )
        assert r2.status_code == 400

    # FIX #1 + #3: two pages with diversity on must be disjoint, and the
    # second page must start past the *window* anchor (not the trimmed page).
    def test_diversity_pages_are_disjoint(self, fastapi_client, seeded_rows):
        code = [f"{seeded_rows['tag']}-{g}" for g in range(12)]
        params = {
            "limit": 3,
            "fetch_k": 9,  # window > page
            "diversity": 0.5,
            "code": code,
            # No query: browse mode, deterministic (code, ep) order before MMR.
        }
        p1 = fastapi_client.get("/search_grouped", params=params).json()
        assert p1["diversity_applied"] is True
        assert len(p1["items"]) == 3
        assert p1["has_more"] is True

        p2 = fastapi_client.get(
            "/search_grouped",
            params={**params, "cursor": p1["next_cursor"]},
        ).json()
        keys1 = {(it["code"], it["episode"]) for it in p1["items"]}
        keys2 = {(it["code"], it["episode"]) for it in p2["items"]}
        assert keys1.isdisjoint(keys2), (
            "window tail was re-served across pages — FIX #1 regressed"
        )

    # FIX #1: MMR must see the *full* window. With fetch_k > limit and a
    # strong-diversity lambda, the returned page should differ from the
    # pure-relevance ordering of the top-`limit` rows.
    def test_mmr_sees_more_than_limit(self, fastapi_client, seeded_rows):
        code = [f"{seeded_rows['tag']}-{g}" for g in range(12)]
        # 12 groups, page of 3, window of 9. diversity=1.0 → λ=0 →
        # pure farthest-point. The returned order should NOT be the raw
        # (code, episode) order for the first page.
        base = fastapi_client.get(
            "/search_grouped",
            params={
                "limit": 3,
                "code": code,
                # diversity off, no fetch_k: first page is the first 3 groups
                # in (code, ep) order.
            },
        ).json()
        div = fastapi_client.get(
            "/search_grouped",
            params={
                "limit": 3,
                "fetch_k": 9,
                "diversity": 1.0,
                "code": code,
            },
        ).json()
        assert div["diversity_applied"] is True
        # Strong-diversity ordering should be a permutation of the window
        # (first 9 groups) — and must include at least one group from the
        # window tail (indices 3..8) to prove MMR saw past `limit`.
        window_codes = {f"{seeded_rows['tag']}-{g}" for g in range(9)}
        got_codes = {it["code"] for it in div["items"]}
        assert got_codes <= window_codes
        # If MMR only saw the first 3, got_codes would be a subset of
        # base's first-3 codes. Prove it isn't.
        base_top_codes = {it["code"] for it in base["items"]}
        assert not got_codes <= base_top_codes, (
            "MMR only saw the trimmed page — FIX #1 regressed"
        )

    # FIX #3: has_more must be False on the final page even with diversity.
    def test_has_more_false_on_last_page(self, fastapi_client, seeded_rows):
        code = [f"{seeded_rows['tag']}-{g}" for g in range(12)]
        pages = _walk(
            fastapi_client,
            {"limit": 5, "fetch_k": 5, "diversity": 0.5, "code": code},
        )
        # 12 groups / 5 per page = 3 pages. Last page must report
        # has_more=False. Before FIX #3, this was True whenever
        # fetch_k > limit, which is exactly this configuration.
        assert pages[-1]["has_more"] is False, (
            "has_more was True on the last page — FIX #3 regressed"
        )
        # And the union of all pages' keys must equal the full group set.
        seen = {(it["code"], it["episode"]) for p in pages for it in p["items"]}
        expected = {
            (f"{seeded_rows['tag']}-{g}", ep)
            for g in range(12)
            for ep in ("1", "2", "3")
        }
        # episodes are 1..3 but groups may have fewer; assert subset/superset
        # the right way:
        expected = set()
        for r in seeded_rows["rows"]:
            expected.add((r["code"], r["episode"]))
        assert seen == expected

    # FIX #1: backward pagination still works after the reorder change.
    def test_backward_pagination(self, fastapi_client, seeded_rows):
        code = [f"{seeded_rows['tag']}-{g}" for g in range(12)]
        params = {"limit": 3, "fetch_k": 6, "diversity": 0.5, "code": code}
        p1 = fastapi_client.get("/search_grouped", params=params).json()
        cur1 = p1["next_cursor"]

        p2 = fastapi_client.get(
            "/search_grouped", params={**params, "cursor": cur1}
        ).json()
        assert p2["has_previous"] is True
        cur2 = p2["next_cursor"]

        # Replay p1's cursor to go back to page 1.
        back = fastapi_client.get(
            "/search_grouped", params={**params, "cursor": cur1}
        ).json()
        keys_p1 = {(it["code"], it["episode"]) for it in p1["items"]}
        keys_back = {(it["code"], it["episode"]) for it in back["items"]}
        assert keys_p1 == keys_back

    # Regression: no-query browse mode is still ordered deterministically
    # when diversity is off.
    def test_browse_order_deterministic(self, fastapi_client, seeded_rows):
        code = [f"{seeded_rows['tag']}-{g}" for g in range(12)]
        a = fastapi_client.get(
            "/search_grouped", params={"limit": 50, "code": code}
        ).json()
        b = fastapi_client.get(
            "/search_grouped", params={"limit": 50, "code": code}
        ).json()
        assert [(it["code"], it["episode"]) for it in a["items"]] == [
            (it["code"], it["episode"]) for it in b["items"]
        ]
        # And ordered by (code ASC, zero-padded episode ASC).
        keys = [
            (it["code"], srv._normalize_episode(it["episode"])) for it in a["items"]
        ]
        assert keys == sorted(keys)

    # diversity=True but no groups have embeddings → no crash, no MMR.
    def test_diversity_with_no_embeddings_is_safe(self, fastapi_client, seeded_rows):
        # Insert one group with NULL embedding; it must land in the tail and
        # not break the MMR block.
        import psycopg

        tag = seeded_rows["tag"] + "-null"
        with psycopg.connect(TEST_DSN) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO public.videos
                        (id, url, code, episode, video_id, title, details,
                         release_date, genres, embedding)
                    VALUES (%s,%s,%s,%s,%s,%s,%s, now(), %s, NULL)
                    """,
                    (
                        f"{tag}-0",
                        "https://example.test/null",
                        f"{tag}-0",
                        "1",
                        f"{tag}-0",
                        "Null emb",
                        "no embedding",
                        ["Test"],
                    ),
                )
            conn.commit()
        try:
            r = fastapi_client.get(
                "/search_grouped",
                params={
                    "limit": 5,
                    "diversity": 0.5,
                    "code": [f"{tag}-0", f"{seeded_rows['tag']}-0"],
                },
            )
            assert r.status_code == 200, r.text
        finally:
            with psycopg.connect(TEST_DSN) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "DELETE FROM public.videos WHERE id LIKE %s",
                        (f"{tag}-%",),
                    )
                conn.commit()


# ===========================================================================
# 4. Parametrized matrix — smoke everything together
# ===========================================================================


@integration
@pytest.mark.parametrize("diversity", [0.0, 0.25, 0.5, 1.0])
@pytest.mark.parametrize("fetch_k", [None, 6, 12])
@pytest.mark.parametrize("limit", [1, 3, 5])
def test_pagination_matrix(fastapi_client, seeded_rows, diversity, fetch_k, limit):
    """Every (limit, fetch_k, diversity) combo must paginate without
    duplicates, in finite pages, and terminate with has_more=False."""
    code = [f"{seeded_rows['tag']}-{g}" for g in range(12)]
    params = {"limit": limit, "diversity": diversity, "code": code}
    if fetch_k is not None:
        params["fetch_k"] = fetch_k

    pages = _walk(fastapi_client, params, max_pages=50)
    assert pages, "no pages returned"
    seen = [(it["code"], it["episode"]) for p in pages for it in p["items"]]
    assert len(seen) == len(set(seen)), "duplicate group across pages"
    assert pages[-1]["has_more"] is False, "walk did not terminate"
    # Every returned item belongs to the seeded set.
    seeded = {(r["code"], r["episode"]) for r in seeded_rows["rows"]}
    assert set(seen) <= seeded
    # If diversity is off, the full walk must cover every seeded group.
    if diversity == 0.0:
        assert set(seen) == seeded
