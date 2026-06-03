"""
CI-Server memory adapter.

Pipeline:
  ingest()  → POST /api/memory/note   (stores fragment in ci.agent_memory)
  flush()   → POST /api/memory/compact, then polls until all fragments have
               processedAt set (i.e. LLM extraction is done)
  search()  → POST /api/memory/recall  (returns graph-backed recall block)

Required env vars (or pass to constructor):
  CI_SERVER_URL    — e.g. http://localhost:8642
  CI_SERVER_TOKEN  — API key (x-api-key)
  CI_DB_CONTAINER  — postgres container name (default: ci-server-database-1)
  CI_DB_NAME       — postgres db name (default: companion)
  CI_DB_USER       — postgres user (default: companion)
"""

from __future__ import annotations

import os
import subprocess
import time
import urllib.error
import urllib.request
import json
from typing import Optional

from .base import MemoryAdapter

_DEFAULT_TIMEOUT = 30.0
_FLUSH_POLL_INTERVAL = 2.0
# Phase 1 (LLM extraction) and Phase 2 (graph write) each get this budget.
# Sized for the slow extraction model: a 27B reasoning model on LM Studio
# (e.g. ornstein-3.6-27b over LAN) takes ~30-60s per 4-fragment batch.
# With BATCH_SIZE=4 and 15 fragments → 4 batches → up to ~4min for phase 1.
# 600s gives headroom for that plus the async per-type CreatedEvent fan-out.
_FLUSH_TIMEOUT = 600.0


class CIServerAdapter(MemoryAdapter):
    def __init__(
        self,
        url: Optional[str] = None,
        token: Optional[str] = None,
        reset: bool = False,
    ):
        self._base = (url or os.environ.get("CI_SERVER_URL", "http://localhost:8642")).rstrip("/")
        self._token = token or os.environ.get("CI_SERVER_TOKEN", "")
        self._db_container = os.environ.get("CI_DB_CONTAINER", "ci-server-database-1")
        self._db_name = os.environ.get("CI_DB_NAME", "companion")
        self._db_user = os.environ.get("CI_DB_USER", "companion")
        self._reset = reset
        self._user_id: str = ""
        self._jwt: str = ""  # used for the /notes and /compact endpoints (JwtOrApiKey)
        self._fragment_count = 0
        self._entity_baseline = 0  # ci.entities count captured at setup()

    @property
    def name(self) -> str:
        return "CI-Server (graph)"

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def setup(self, user_id: str) -> None:
        self._user_id = user_id
        self._fragment_count = 0

        if self._reset:
            self._reset_benchmark_state()

        # Capture how many embeddings exist before this run.  Phase-2 polls
        # ci_search.embeddings rather than ci.entities because /api/memory/recall
        # queries the embedding/tsvector index, which is populated *after* the
        # ci.entities row is written by an async per-type listener.  Polling
        # entities was a proxy and gave a false "done" before recall could hit.
        self._entity_baseline = self._embedding_count()

    def teardown(self) -> None:
        # No automatic teardown — re-runs would otherwise drop fresh data the
        # user might want to inspect. Use --reset for a clean slate.
        pass

    # ------------------------------------------------------------------
    # Core operations
    # ------------------------------------------------------------------

    def ingest(self, text: str, session_id: str) -> None:
        self._post(
            "/api/memory/note",
            {"content": text, "source": "benchmark", "sessionId": session_id},
        )
        self._fragment_count += 1

    def flush(self) -> None:
        """
        Trigger compaction and wait until the results are searchable.

        Two-phase wait:
          Phase 1 — poll /memory/notes until every fragment has processedAt set.
                     This confirms the LLM extraction pass finished.
          Phase 2 — probe /memory/recall until resultCount > 0.
                     This confirms the async PGBoss graph-write events have been
                     processed and the search index is populated.
                     (upsertNode only *queues* a PGBoss job; the actual write to
                     ci.entities happens asynchronously on a separate worker.)
        """
        if self._fragment_count == 0:
            return

        # Trigger the manual compaction endpoint.
        result = self._post_jwt("/api/memory/compact", {})
        queued = result.get("queued", 0)
        if queued == 0:
            print("  [CI-Server] compact returned queued=0 — "
                  "no fragments eligible (check API key auth or server logs)")
            return

        print(f"  [CI-Server] compacting {queued} fragment(s)…")

        # Phase 1: poll until processedAt is stamped on every benchmark fragment.
        deadline = time.monotonic() + _FLUSH_TIMEOUT
        while time.monotonic() < deadline:
            time.sleep(_FLUSH_POLL_INTERVAL)
            notes = self._get_jwt("/api/memory/notes")
            if isinstance(notes, list):
                # Only watch benchmark-sourced fragments to avoid waiting on the
                # user's own unprocessed notes.
                bench = [n for n in notes if n.get("source") == "benchmark"]
                pending = [n for n in bench if not n.get("processedAt")]
                if bench and not pending:
                    break
        else:
            print("  [CI-Server] phase-1 timed out — fragments may not be fully extracted")
            return

        # Phase 2: wait for ci_search.embeddings to grow AND settle — that's the
        # index /api/memory/recall actually queries.  Going through embeddings
        # (not ci.entities) covers the async per-type search-ingress listener
        # that runs after the entity is written.
        #
        # We wait for the count to *stabilize* (no change across two polls), not
        # merely to exceed the baseline.  The listener fans out per entity, so
        # the count climbs gradually; returning on first increase let the first
        # eval question race ahead of indexing and spuriously miss.
        print("  [CI-Server] waiting for search index to catch up…")
        deadline2 = time.monotonic() + _FLUSH_TIMEOUT
        last_count = self._entity_baseline
        stable_polls = 0
        while time.monotonic() < deadline2:
            time.sleep(_FLUSH_POLL_INTERVAL)
            current = self._embedding_count()
            if current > last_count:
                last_count = current
                stable_polls = 0
                continue
            if current > self._entity_baseline:
                # No growth this poll and we're above baseline → likely settled.
                stable_polls += 1
                if stable_polls >= 2:
                    added = current - self._entity_baseline
                    print(f"  [CI-Server] {added} new entity/entities indexed for search (settled)")
                    return

        print("  [CI-Server] phase-2 timed out — no new entries in ci_search.embeddings. "
              "Either the LLM extracted 0 entities or the per-type CreatedEvent fan-out is broken.")

    def search(self, query: str) -> str:
        result = self._post(
            "/api/memory/recall",
            {"query": query, "maxResults": 10},
        )
        return result.get("block", "")

    # ------------------------------------------------------------------
    # HTTP helpers (API key auth — for agent-facing endpoints)
    # ------------------------------------------------------------------

    def _post(self, path: str, payload: dict) -> dict:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(f"{self._base}{path}", data=data, method="POST")
        req.add_header("x-api-key", self._token)
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=_DEFAULT_TIMEOUT) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
            raise RuntimeError(f"CI-Server {path} → HTTP {exc.code}: {body[:200]}") from exc

    # ------------------------------------------------------------------
    # HTTP helpers (JWT auth — for settings-UI endpoints)
    # The benchmark uses the same API key but via the JwtOrApiKey guard,
    # so we can pass x-api-key here too.
    # ------------------------------------------------------------------

    def _post_jwt(self, path: str, payload: dict) -> dict:
        return self._post(path, payload)

    def _get_jwt(self, path: str) -> object:
        req = urllib.request.Request(f"{self._base}{path}", method="GET")
        req.add_header("x-api-key", self._token)
        req.add_header("Accept", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=_DEFAULT_TIMEOUT) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                return json.loads(body) if body else []
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
            raise RuntimeError(f"CI-Server GET {path} → HTTP {exc.code}: {body[:200]}") from exc

    # ------------------------------------------------------------------
    # Direct DB helpers
    #
    # Used by phase-2 of flush() and by --reset.  We bypass the HTTP layer
    # for these because the API doesn't expose an entity-count endpoint and
    # the recall endpoint matches fragment embeddings (false positives).
    # ------------------------------------------------------------------

    def _psql(self, sql: str) -> str:
        """Run a one-shot SQL command via docker exec.  Returns stdout."""
        result = subprocess.run(
            ["docker", "exec", self._db_container,
             "psql", "-U", self._db_user, "-d", self._db_name,
             "-tAc", sql],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            raise RuntimeError(f"psql failed: {result.stderr.strip()}")
        return result.stdout.strip()

    def _entity_count(self) -> int:
        try:
            return int(self._psql("SELECT COUNT(*) FROM ci.entities;") or "0")
        except Exception as exc:
            print(f"  [CI-Server] entity count failed ({exc}); treating as 0")
            return 0

    def _embedding_count(self) -> int:
        try:
            return int(self._psql("SELECT COUNT(*) FROM ci_search.embeddings;") or "0")
        except Exception as exc:
            print(f"  [CI-Server] embedding count failed ({exc}); treating as 0")
            return 0

    def _reset_benchmark_state(self) -> None:
        """Full wipe of the benchmark owner's graph, PRESERVING the canonical
        user node (ci.users.entity_id).

        The benchmark is recentred on the account's canonical self node so that
        first-person facts anchor to it (via compaction self-resolution). For a
        clean measurement every run starts from a blank graph for that owner —
        but we must keep the canonical Person node itself, otherwise
        ci.users.entity_id dangles and resolveUserEntity() falls back to an
        arbitrary Person. So: delete everything the owner owns except that one
        node (and its embedding/vector), plus all their relationships and
        benchmark fragments. Destructive by design — dev/benchmark use only.
        """
        try:
            # Owner + canonical self node come straight from ci.users (the same
            # linkage UserContextService.resolveUserEntity uses).
            row = self._psql(
                "SELECT id::text || '|' || COALESCE(entity_id::text,'') "
                "FROM ci.users WHERE entity_id IS NOT NULL ORDER BY id LIMIT 1;"
            )
            if not row or "|" not in row:
                print("  [CI-Server] --reset: no canonical user found; skipping wipe")
                self._psql("DELETE FROM ci.agent_memory WHERE source='benchmark';")
                return

            owner, canonical = row.split("|", 1)
            owner = owner.strip()
            canonical = canonical.strip()

            self._psql("DELETE FROM ci.agent_memory WHERE source='benchmark';")
            # graph_deltas carries owner_user_id, so clear it wholesale (avoids
            # the FK/CHECK dance) before relationships and entities.
            self._psql(f"DELETE FROM ci.graph_deltas WHERE owner_user_id='{owner}';")
            self._psql(f"DELETE FROM ci.relationships WHERE owner_user_id='{owner}';")
            self._psql(
                f"DELETE FROM ci_search.embeddings WHERE user_id='{owner}' AND entity_id <> '{canonical}';"
            )
            self._psql(
                f"DELETE FROM ci_search.vectors WHERE user_id='{owner}' AND entity_id <> '{canonical}';"
            )
            deleted = self._psql(
                f"DELETE FROM ci.entities WHERE owner_user_id='{owner}' "
                f"AND entity_id <> '{canonical}' RETURNING 1;"
            )
            rows = len(deleted.splitlines()) if deleted else 0
            print(f"  [CI-Server] --reset: full wipe of owner {owner[:8]}… "
                  f"({rows} entities removed, canonical self node {canonical[:8]}… preserved)")
        except Exception as exc:
            print(f"  [CI-Server] --reset failed ({exc}); continuing without cleanup")
