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


# --------------------------------------------------------------------------- #
# OpenViking — volcengine "context database". Extraction-based, like mem0/
# hindsight: messages are added to a session, then `extract` runs the VLM
# (gemma-31b) to distill them into typed entity memories; `find` does semantic
# retrieval and returns the memory content in each hit's `abstract`.
# Talks to a host-run openviking-server (REST) configured for local models
# (.203 gemma-31b VLM + nomic embeddings). Data dir is wiped out-of-band before
# the run (see orchestrator.openviking_wipe), so reset() just opens a session.
# --------------------------------------------------------------------------- #

class OpenVikingBackend:
    name = "OpenViking (context DB)"
    EXTRACT_EVERY = 25  # extract+commit every N messages so the VLM context stays small

    def __init__(self) -> None:
        self._base = os.environ.get("OPENVIKING_URL", "http://host.docker.internal:1933").rstrip("/")
        self._key = os.environ.get("OPENVIKING_API_KEY", "benchkey")
        self._sid: str | None = None
        self._pending = 0

    def _post(self, path: str, payload: dict, timeout: float = 300.0) -> dict:
        req = urllib.request.Request(f"{self._base}{path}", data=json.dumps(payload).encode(), method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("x-api-key", self._key)
        req.add_header("X-OpenViking-Account", "default")
        req.add_header("X-OpenViking-User", "default")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8", "replace")
        return json.loads(body) if body else {}

    def reset(self) -> None:
        # Clean slate comes from wiping the server's data dir out-of-band; here we
        # just open a fresh session to accumulate this run's messages.
        r = self._post("/api/v1/sessions", {})
        self._sid = (r.get("result") or {}).get("session_id") or r.get("session_id")
        self._pending = 0

    def _extract_commit(self) -> None:
        if not self._sid:
            return
        try:
            self._post(f"/api/v1/sessions/{self._sid}/extract", {}, timeout=600)
            # clear processed messages so the next extract sees only new ones
            self._post(f"/api/v1/sessions/{self._sid}/commit", {"keep_recent_count": 0}, timeout=180)
        except Exception:  # noqa: BLE001 — extraction is best-effort per batch
            pass
        self._pending = 0

    def ingest(self, text: str, session_id: str) -> None:
        if not self._sid:
            self.reset()
        self._post(f"/api/v1/sessions/{self._sid}/messages", {"role": "user", "content": text})
        self._pending += 1
        if self._pending >= self.EXTRACT_EVERY:
            self._extract_commit()

    def flush(self) -> None:
        if self._sid and self._pending > 0:
            self._extract_commit()

    def retrieve(self, query: str) -> list[str]:
        r = self._post("/api/v1/search/find", {"query": query, "limit": TOP_K}, timeout=120)
        res = r.get("result") or {}
        out: list[str] = []
        for m in (res.get("memories") or [])[:TOP_K]:
            uri = m.get("uri", "")
            # skip structural scope markers (…/.abstract.md, …/.overview.md)
            if uri.endswith(".abstract.md") or uri.endswith(".overview.md"):
                continue
            t = (m.get("abstract") or m.get("overview") or "").strip()
            if t:
                out.append(t)
        return out


# --------------------------------------------------------------------------- #
# Holographic — NousResearch Hermes built-in memory provider, vendored from
# hermes-agent/plugins/memory/holographic (store.py + retrieval.py +
# holographic.py; the Hermes-runtime __init__.py glue is replaced by this
# adapter). A LOCAL SQLite fact store: FTS5 keyword + Jaccard + HRR
# (holographic reduced representations) retrieval, with trust scoring. NO LLM
# and NO embeddings — ingest is instant; retrieval is keyword/algebraic, so it
# is sensitive to query↔fact term overlap (a real characteristic, not a bug).
# --------------------------------------------------------------------------- #

class HolographicBackend:
    name = "Holographic (SQLite FTS5+HRR)"

    def __init__(self) -> None:
        from _holographic.store import MemoryStore
        from _holographic.retrieval import FactRetriever
        self._MemoryStore = MemoryStore
        self._FactRetriever = FactRetriever
        self.reset()

    def reset(self) -> None:
        import tempfile
        self._db = tempfile.mktemp(suffix=".db", dir="/tmp")
        self._store = self._MemoryStore(db_path=self._db)
        self._retriever = self._FactRetriever(self._store)  # default fts/jaccard/hrr weights + hrr_dim=1024

    def ingest(self, text: str, session_id: str) -> None:
        # No LLM/embeddings — a plain fact insert + FTS5/HRR index update.
        self._store.add_fact(text, category="general")

    def flush(self) -> None:
        pass  # FTS5/HRR index synchronously on add; nothing async to settle

    # FTS5 MATCH treats space-separated terms as implicit AND, so a raw
    # natural-language question ("what is the name of Max's cat") requires one
    # fact containing ALL those words → it AND-misses → 0 results. Holographic
    # has no semantic embedder to handle raw questions, so (like our naive
    # baseline and ci_server's boosted search, which OR their keyword terms) we
    # send an OR-of-keywords query; HRR + Jaccard + trust then re-rank the
    # candidates. Without this the keyword store returns ~nothing.
    _STOP = {"what", "who", "whom", "whose", "where", "when", "which", "why", "how",
             "does", "do", "did", "is", "are", "was", "were", "be", "the", "a", "an",
             "of", "to", "for", "in", "on", "at", "and", "or", "with", "have", "has",
             "had", "his", "her", "their", "they", "you", "your"}

    def _fts_or_query(self, query: str) -> str:
        import re
        toks = [t for t in re.findall(r"[A-Za-z0-9]+", query.lower())
                if len(t) > 1 and t not in self._STOP]
        return " OR ".join(toks) if toks else query

    def retrieve(self, query: str) -> list[str]:
        # min_trust=0.0 — we give no feedback, so don't trust-filter.
        res = self._retriever.search(self._fts_or_query(query), min_trust=0.0, limit=TOP_K)
        return [r.get("content", "") for r in res if r.get("content")]


# --------------------------------------------------------------------------- #
# TencentDB Agent Memory — TencentCloud's local-first memory system (MIT).
# A 4-tier progressive pipeline (L0 raw turns -> L1 extracted memories ->
# L2 scenes -> personas) over local SQLite + sqlite-vec (vector) and BM25.
# We drive its standalone `TdaiGateway` HTTP server (run on the host, like
# OpenViking), configured for local models: gemma-31b extraction + nomic
# embeddings via LM Studio. The gateway's SQLite store is wiped + the gateway
# restarted out-of-band before a run (see tencentdb/run_gateway.sh), so reset()
# just fixes the session key.
#
# Contract mapping:  ingest -> POST /capture ; flush -> POST /session/end
# (runs the session's buffered L0->L1 extraction) ; retrieve -> POST
# /search/memories (hybrid vec+BM25 over the extracted L1 memories).
#
# Platform caveat: Node's built-in `node:sqlite` lacks FTS5, so the SQLite-FTS5
# keyword arm is unavailable on this host (the JS BM25 encoder + sqlite-vec
# vector search are active). The vendored Docker image ships an FTS5-enabled
# SQLite; here recall is vector-dominant. Flagged in the writeup.
# --------------------------------------------------------------------------- #

class TencentDBBackend:
    name = "TencentDB Agent Memory (sqlite-vec)"

    def __init__(self) -> None:
        self._base = os.environ.get("TENCENTDB_URL", "http://host.docker.internal:8420").rstrip("/")
        self._skey = "bench"

    def _post(self, path: str, payload: dict, timeout: float = 600.0) -> dict:
        req = urllib.request.Request(f"{self._base}{path}", data=json.dumps(payload).encode(), method="POST")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8", "replace")
        return json.loads(body) if body else {}

    def reset(self) -> None:
        # Fresh store comes from wiping the gateway's SQLite data dir + restarting
        # it out-of-band before the run. One session_key groups the whole corpus
        # as a single ongoing conversation so the L1 extractor aggregates over it.
        self._skey = "bench"

    def ingest(self, text: str, session_id: str) -> None:
        # /capture is turn-shaped (user + assistant). The corpus is documents, not
        # dialogues, so each statement is the user turn with a constant ack (the
        # extractor reads facts from the user turn). We then /session/end to force
        # AND AWAIT this turn's L0->L1 extraction before the next capture.
        #
        # The per-message serialization is required, not incidental: the pipeline
        # scheduler COALESCES rapid captures ("L1 already queued, skipping"), which
        # strands un-extracted messages (a batch of 3 yielded only 1 memory). With
        # everyNConversations=1 + warmup off + flush-per-turn, extraction keeps pace
        # and nothing is lost — at the cost of one gemma extraction call per message
        # (so TencentDB's ingest is on the slower side; an honest Phase-A cost).
        self._post("/capture", {
            "session_key": self._skey,
            "user_content": text,
            "assistant_content": "Noted.",
        }, timeout=300)
        self._post("/session/end", {"session_key": self._skey}, timeout=600)

    def flush(self) -> None:
        # Per-message ingest already extracts every turn; this is a final settle
        # for any trailing scene/L2 aggregation + vec indexing.
        self._post("/session/end", {"session_key": self._skey}, timeout=600)
        time.sleep(10)

    def retrieve(self, query: str) -> list[str]:
        r = self._post("/search/memories", {"query": query, "limit": TOP_K}, timeout=120)
        text = r.get("results", "") or ""
        if not text or text.startswith("No matching"):
            return []
        # Format is "Found N matching memories:\n\n- **[type]** (...)\n  <content>\n..."
        # Keep the indented content lines; drop the header and the per-item meta line.
        out: list[str] = []
        for line in text.splitlines():
            s = line.strip()
            if not s or s.startswith("Found ") or s.startswith("- **["):
                continue
            out.append(s)
        return out[:TOP_K]


def make_backend():
    system = os.environ.get("SYSTEM", "naive").lower()
    return {
        "naive": NaiveBackend,
        "mem0": Mem0Backend,
        "hindsight": HindsightBackend,
        "ci_server": CIServerBackend,
        "openviking": OpenVikingBackend,
        "holographic": HolographicBackend,
        "tencentdb": TencentDBBackend,
    }[system]()
