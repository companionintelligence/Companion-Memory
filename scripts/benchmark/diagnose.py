#!/usr/bin/env python3
"""
Minimal CI-Server memory pipeline diagnostic.

Sends ONE simple test fragment, triggers compaction, then checks the DB
to see if an entity was written.  This isolates the LLM extraction step
from everything else in the benchmark.

Usage:
  CI_SERVER_TOKEN=<key> python diagnose.py

The script prints a clear PASS / FAIL at each stage so you can see
exactly where the pipeline breaks.
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error

BASE   = os.environ.get("CI_SERVER_URL", "http://localhost:8642").rstrip("/")
TOKEN  = os.environ.get("CI_SERVER_TOKEN", "")
DBNAME = os.environ.get("CI_DB_NAME", "companion")
DBUSER = os.environ.get("CI_DB_USER", "companion")

OLLAMA   = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")

FRAGMENT = (
    "My best friend Sam Rivera is a product manager at Google. "
    "He lives in Seattle, Washington and we met at PyCon 2022."
)

def api(method: str, path: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
    req.add_header("x-api-key", TOKEN)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read().decode()
        return json.loads(body) if body else {}

def step(label: str) -> None:
    print(f"\n{'─'*55}")
    print(f"  {label}")
    print(f"{'─'*55}")

# ── 0. Check Ollama and available models ─────────────────────────────────
step("0. Ollama model check — GET /api/tags")
try:
    req = urllib.request.Request(f"{OLLAMA}/api/tags")
    with urllib.request.urlopen(req, timeout=5) as r:
        tags = json.loads(r.read())
    models = [m["name"] for m in tags.get("models", [])]
    print(f"  ✓ Ollama reachable  ({len(models)} model(s) available)")
    for m in models:
        marker = "  ← PROMPT_MODEL (used by compaction)" if m == "gemma3:1b" else ""
        print(f"       {m}{marker}")
    if "gemma3:1b" not in models:
        print()
        print("  ✗ 'gemma3:1b' is NOT installed — this is why the LLM never fires.")
        print("    The compaction service calls validateModel() which throws, then")
        print("    silently catches the error and returns empty entities.")
        print()
        print("    Fix — either:")
        print("      a) Pull the model:  ollama pull gemma3:1b")
        print("      b) Change PROMPT_MODEL in OllamaService.ts to a model you have")
        print(f"         Available: {', '.join(models) or '(none)'}")
except Exception as exc:
    print(f"  ✗ Cannot reach Ollama at {OLLAMA}: {exc}")

# ── 1. Check connectivity ─────────────────────────────────────────────────
step("1. Connectivity check — GET /api/health")
try:
    req = urllib.request.Request(f"{BASE}/api/health")
    req.add_header("x-api-key", TOKEN)
    with urllib.request.urlopen(req, timeout=5) as r:
        print(f"  ✓ Server reachable  status={r.status}")
except Exception as exc:
    print(f"  ✗ Cannot reach server: {exc}")
    sys.exit(1)

# ── 2. Write test fragment ────────────────────────────────────────────────
step("2. Ingest test fragment — POST /api/memory/note")
try:
    api("POST", "/api/memory/note", {
        "content": FRAGMENT,
        "source": "diagnose",
        "sessionId": "diagnose_session",
    })
    print(f"  ✓ Fragment written")
    print(f"  Fragment: {FRAGMENT[:80]}…")
except Exception as exc:
    print(f"  ✗ Ingest failed: {exc}")
    sys.exit(1)

# ── 3. Trigger compaction ─────────────────────────────────────────────────
step("3. Trigger compaction — POST /api/memory/compact")
try:
    result = api("POST", "/api/memory/compact", {})
    queued = result.get("queued", 0)
    print(f"  queued={queued}")
    if queued == 0:
        print("  ✗ queued=0 — fragment not eligible. Possible causes:")
        print("     • API key resolves to a different user than the one who wrote the fragment")
        print("     • Server is using old (pre-minAgeMinutes=0) code — restart dev server")
        sys.exit(1)
    print(f"  ✓ Compaction triggered for {queued} fragment(s)")
except Exception as exc:
    print(f"  ✗ Compact failed: {exc}")
    sys.exit(1)

# ── 4. Wait for processedAt ───────────────────────────────────────────────
step("4. Waiting for processedAt — GET /api/memory/notes")
deadline = time.monotonic() + 60
processed = False
while time.monotonic() < deadline:
    time.sleep(2)
    try:
        notes = api("GET", "/api/memory/notes")
        if isinstance(notes, list):
            pending = [n for n in notes if n.get("source") == "diagnose" and not n.get("processedAt")]
            done    = [n for n in notes if n.get("source") == "diagnose" and n.get("processedAt")]
            if done and not pending:
                print(f"  ✓ processedAt stamped on {len(done)} fragment(s)")
                processed = True
                break
    except Exception:
        pass

if not processed:
    print("  ✗ Timed out waiting for processedAt — compaction service may not be running")
    sys.exit(1)

# ── 4.5. Direct Ollama test — bypass NestJS entirely ─────────────────────
step("4.5. Direct Ollama inference test (same prompt as compaction)")
SYSTEM_PROMPT = (
    'You are a personal knowledge graph assistant. Extract PERSONAL biographical '
    'facts about the user. Return ONLY valid JSON: '
    '{"entities":[{"type":"person","name":"Sam Rivera"}],"relationships":[]}'
    '\nIf nothing to extract return {"entities":[],"relationships":[]}'
)
USER_MSG = f"Extract entities from: {FRAGMENT}"
ollama_payload = {
    "model": "gemma3:1b",
    "messages": [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": USER_MSG},
    ],
    "format": "json",
    "stream": False,
}
try:
    data = json.dumps(ollama_payload).encode()
    req = urllib.request.Request(f"{OLLAMA}/api/chat", data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    t0 = time.monotonic()
    with urllib.request.urlopen(req, timeout=60) as r:
        resp = json.loads(r.read())
    elapsed = time.monotonic() - t0
    content = resp.get("message", {}).get("content", "")
    print(f"  ✓ Ollama responded in {elapsed:.1f}s")
    print(f"  Raw output: {content!r}")
    try:
        parsed = json.loads(content)
        entities = parsed.get("entities", [])
        print(f"  Parsed:  {len(entities)} entity/entities")
        for e in entities:
            print(f"    • type={e.get('type')}  name={e.get('name')}")
        if not entities:
            print("  ✗ LLM returned empty entities — extraction prompt not working for gemma3:1b")
    except Exception:
        print(f"  ✗ Response is not valid JSON")
except Exception as exc:
    print(f"  ✗ Ollama call failed: {exc}")

# ── 5. Check DB for new entities ──────────────────────────────────────────
step("5. Check ci.entities for newly written entities")

import subprocess
sql = """
SELECT entity_type, name, created_at
FROM ci.entities
WHERE created_at > NOW() - INTERVAL '2 minutes'
ORDER BY created_at DESC;
"""
try:
    result = subprocess.run(
        ["docker", "exec", "ci-server-database-1",
         "psql", "-U", DBUSER, "-d", DBNAME, "-c", sql],
        capture_output=True, text=True, timeout=10,
    )
    output = result.stdout.strip()
    if "(0 rows)" in output or not output:
        print("  ✗ No new entities in ci.entities")
        print("     Possible causes:")
        print("     • LLM returned {\"entities\":[]} — check server logs for")
        print("       'Extracted knowledge from batch' with entityCount=0")
        print("     • PGBoss GRAPH_NODE_UPSERTED events are stuck")
        print("     • Entity type was not in ['person','concept','place','event','item','content']")
    else:
        print("  ✓ New entities found:")
        for line in output.splitlines():
            print(f"       {line}")
except Exception as exc:
    print(f"  (DB check skipped — {exc})")
    print("  Run manually:")
    print(f"    docker exec ci-server-database-1 psql -U {DBUSER} -d {DBNAME} -c '{sql.strip()}'")

# ── 6. Check recall ───────────────────────────────────────────────────────
step("6. Test recall — POST /api/memory/recall")
time.sleep(3)  # brief wait for search index
try:
    for query in ["Sam Rivera", "Seattle", "Google"]:
        result = api("POST", "/api/memory/recall", {"query": query, "maxResults": 5})
        count = result.get("resultCount", 0)
        block = result.get("block", "")
        icon = "✓" if count > 0 else "✗"
        print(f"  {icon} '{query}'  resultCount={count}  blockLen={len(block)}")
        if block:
            print(f"       preview: {block[:100]!r}")
except Exception as exc:
    print(f"  ✗ Recall failed: {exc}")

print(f"\n{'='*55}")
print("  Diagnosis complete — see results above.")
print(f"{'='*55}\n")
