"""
Memory backends, one per system. Each exposes the same surface:

  reset()                       — clear store for a fresh run (best effort)
  ingest(text, session_id)      — store one statement
  flush()                       — block until queryable
  retrieve(query) -> list[str]  — return memory snippets via the system's
                                  NATIVE interface (this is the key fairness
                                  point — we use each tool the way it's meant
                                  to be used, then a shared answerer reasons).

The container's /answer endpoint = retrieve() + the shared answerer.
"""

from __future__ import annotations

import json
import math
import os
import time
import urllib.request

OLLAMA = os.environ.get("OLLAMA_HOST", "http://host.docker.internal:11434").rstrip("/")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "nomic-embed-text")
TOP_K = int(os.environ.get("TOP_K", "10"))


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def _embed(text: str, retries: int = 4, timeout: float = 60.0) -> list[float]:
    # Retry transient Ollama timeouts; return [] on persistent failure so one
    # bad call degrades (skips a memory) instead of crashing the whole run.
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                f"{OLLAMA}/api/embeddings",
                data=json.dumps({"model": EMBED_MODEL, "prompt": text}).encode(),
                method="POST",
            )
            req.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(req, timeout=timeout) as r:
                vec = json.loads(r.read()).get("embedding", []) or []
            if vec:
                return vec
        except Exception:
            time.sleep(1.0 * (attempt + 1))
    return []


def _cosine(a: list[float], b: list[float]) -> float:
    n = min(len(a), len(b))
    if not n:
        return 0.0
    dot = sum(a[i] * b[i] for i in range(n))
    na = math.sqrt(sum(x * x for x in a[:n]))
    nb = math.sqrt(sum(x * x for x in b[:n]))
    return dot / (na * nb) if na and nb else 0.0


# --------------------------------------------------------------------------- #
# Naive RAG
# --------------------------------------------------------------------------- #

class NaiveBackend:
    name = "Naive RAG (vector)"

    def __init__(self) -> None:
        self._store: list[tuple[str, list[float]]] = []

    def reset(self) -> None:
        self._store = []

    def ingest(self, text: str, session_id: str) -> None:
        v = _embed(text)
        if v:
            self._store.append((text, v))

    def flush(self) -> None:
        pass

    def retrieve(self, query: str) -> list[str]:
        if not self._store:
            return []
        qv = _embed(query)
        return [t for t, _ in sorted(self._store, key=lambda it: _cosine(qv, it[1]), reverse=True)[:TOP_K]]


# --------------------------------------------------------------------------- #
# Mem0 — native consolidation, retrieval re-ranked with cosine (Chroma's
# default L2 ranking is broken for unnormalized vectors; see DEFERRED_NOTES).
# --------------------------------------------------------------------------- #

class Mem0Backend:
    name = "Mem0 (vector)"

    def __init__(self) -> None:
        self._user = "bench_user"
        self._mem = None
        self._emb_cache: dict[str, list[float]] = {}

    def _ensure(self) -> None:
        from mem0 import Memory

        llm_base = os.environ.get("MEM0_LLM_BASE_URL", "http://localhost:1235/v1")
        self._mem = Memory.from_config({
            "llm": {"provider": "openai", "config": {
                "model": os.environ.get("LLM_MODEL", "gemma-4-31b-it-abliterated"),
                "openai_base_url": llm_base, "api_key": "lm-studio", "temperature": 0}},
            "embedder": {"provider": "ollama", "config": {
                "model": EMBED_MODEL, "ollama_base_url": OLLAMA, "embedding_dims": 768}},
            "vector_store": {"provider": "chroma", "config": {
                "collection_name": "bench", "path": "/tmp/mem0_v2"}},
        })

    def reset(self) -> None:
        import shutil
        shutil.rmtree("/tmp/mem0_v2", ignore_errors=True)
        self._emb_cache = {}
        self._ensure()

    def ingest(self, text: str, session_id: str) -> None:
        self._mem.add(text, user_id=self._user, metadata={"session_id": session_id})

    def flush(self) -> None:
        pass

    def retrieve(self, query: str) -> list[str]:
        res = self._mem.search(query, top_k=10000, filters={"user_id": self._user})
        if isinstance(res, dict):
            res = res.get("results", [])
        mems = [r.get("memory", "") for r in res if isinstance(r, dict) and r.get("memory")]
        if not mems:
            return []
        qv = _embed(query)
        if not qv:
            return mems[:TOP_K]

        def emb(m: str) -> list[float]:
            if m not in self._emb_cache:
                self._emb_cache[m] = _embed(m)
            return self._emb_cache[m]

        return sorted(mems, key=lambda m: _cosine(qv, emb(m)), reverse=True)[:TOP_K]


# --------------------------------------------------------------------------- #
# Hindsight — native retain/recall against the running Hindsight server
# --------------------------------------------------------------------------- #

class HindsightBackend:
    name = "Hindsight (retain/recall)"

    def __init__(self) -> None:
        self._client = None
        self._bank = "bench_user"  # name the bank as the user so memories ground correctly

    def _ensure(self) -> None:
        from hindsight_client import Hindsight
        base = os.environ.get("HINDSIGHT_BASE_URL", "http://host.docker.internal:8888")
        self._client = Hindsight(base_url=base, timeout=180)

    def reset(self) -> None:
        self._ensure()
        # fresh bank per run so prior data doesn't bleed in
        self._bank = "bench_user_" + os.urandom(3).hex()

    def ingest(self, text: str, session_id: str) -> None:
        # ASYNC retain: enqueue fast and return, so the server can consolidate the
        # backlog at HINDSIGHT_API_LLM_MAX_CONCURRENT (we run it at 4). A sync
        # retain serialises one ~17s consolidation per call (the orchestrator
        # ingests sequentially), wasting the server's concurrency.
        self._client.retain(bank_id=self._bank, content=text, document_id=session_id, retain_async=True)

    def flush(self) -> None:
        # Wait for the async consolidation backlog to fully drain. With async
        # retain, recall result-count grows as consolidation proceeds; we treat
        # it as drained when the count stops growing for a sustained window.
        # Generous deadline: 490 facts / 4 concurrent * ~17s ≈ 35 min worst case.
        last, stable, started = -1, 0, time.monotonic()
        deadline = started + 2700  # 45 min
        STABLE_NEEDED = 5          # count unchanged across 5 polls (~50s) = drained
        while time.monotonic() < deadline:
            try:
                r = self._client.recall(bank_id=self._bank, query="what do you know about the user",
                                        max_tokens=4096, budget="high")
                n = len(getattr(r, "results", []) or [])
            except Exception:  # noqa: BLE001 — transient during heavy consolidation
                n = last
            # Only allow "drained" once we've actually seen memories form.
            if n == last and n > 0:
                stable += 1
                if stable >= STABLE_NEEDED:
                    break
            else:
                stable = 0 if n != last else stable
                last = n
            time.sleep(10)
        time.sleep(10)  # final settle

    def retrieve(self, query: str) -> list[str]:
        r = self._client.recall(bank_id=self._bank, query=query, max_tokens=4096, budget="high")
        res = getattr(r, "results", None) or (r.get("results", []) if isinstance(r, dict) else [])
        out = []
        for x in res[:TOP_K]:
            t = getattr(x, "text", None) or (x.get("text", "") if isinstance(x, dict) else "")
            if t:
                out.append(t)
        return out


# --------------------------------------------------------------------------- #
# CI-Server — sidecar driving the existing service via its intended path
# (note -> compact -> recall). No CI-Server code changes.
# --------------------------------------------------------------------------- #

class CIServerBackend:
    name = "CI-Server (graph)"

    def __init__(self) -> None:
        self._base = os.environ.get("CI_SERVER_URL", "http://host.docker.internal:8642").rstrip("/")
        self._token = os.environ.get("CI_SERVER_TOKEN", "")

    def _post(self, path: str, payload: dict) -> dict:
        req = urllib.request.Request(f"{self._base}{path}", data=json.dumps(payload).encode(), method="POST")
        req.add_header("x-api-key", self._token)
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode("utf-8", "replace")
            return json.loads(body) if body else {}

    def _get(self, path: str):
        req = urllib.request.Request(f"{self._base}{path}", method="GET")
        req.add_header("x-api-key", self._token)
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode("utf-8", "replace")
            return json.loads(body) if body else []

    def reset(self) -> None:
        # Intentionally a no-op: the harness orchestrator triggers CI-Server's
        # own /reset path (full wipe preserving the canonical node) out-of-band,
        # because that is DB-level. Sidecar stays read/write via the API only.
        pass

    def ingest(self, text: str, session_id: str) -> None:
        self._post("/api/memory/write", {"content": text, "source": "benchmark", "sessionId": session_id})

    def flush(self) -> None:
        result = self._post("/api/memory/compact", {})
        if result.get("queued", 0) == 0:
            return
        # Compaction marks processed_at on ALL fragments at once at the very end
        # (MemoryCompactionService stamps the whole batch after every LLM sub-batch
        # runs), so processed flips 0 -> all-done. A 342-fragment corpus at
        # BATCH_SIZE=4 is ~86 LLM calls ≈ 12 min, so the deadline must be generous.
        deadline = time.monotonic() + 1800
        while time.monotonic() < deadline:
            time.sleep(5)
            notes = self._get("/api/memory/notes")
            if isinstance(notes, list):
                bench = [n for n in notes if n.get("source") == "benchmark"]
                if bench and not [n for n in bench if not n.get("processedAt")]:
                    break
        time.sleep(45)  # let async graph indexing settle (hundreds of entities)

    def retrieve(self, query: str) -> list[str]:
        res = self._post("/api/memory/recall", {"query": query, "maxResults": TOP_K})
        block = res.get("block", "") or ""
        # block is "## Relevant context\n<line>\n<line>..."
        return [ln for ln in block.splitlines() if ln and not ln.startswith("#")]


def make_backend():
    system = os.environ.get("SYSTEM", "naive").lower()
    return {
        "naive": NaiveBackend,
        "mem0": Mem0Backend,
        "hindsight": HindsightBackend,
        "ci_server": CIServerBackend,
    }[system]()
