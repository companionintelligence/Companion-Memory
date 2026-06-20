#!/usr/bin/env python3
"""Backfill: embed raw benchmark messages into ci_search.embeddings as type
'message', so CI-Server's native recall message-channel (RecallService →
SearchService.searchMessages) can vector-search them — no re-ingest needed.

Uses the SAME embedder as the query path: Ollama nomic-embed-text, raw text, no
task prefix (matches EmbeddingGenerationService.generateEmbeddingString). Inserts
contain only uuids + numeric vectors (no free text), so the generated SQL is safe.
Idempotent: clears existing type='message' rows for the owner first.
"""
import concurrent.futures
import csv
import io
import subprocess
import urllib.request
import json

OWNER = "019e7450-d3f4-74be-934a-fff32b513c76"
DB = "ci-server-database-1"
OLLAMA = "http://localhost:11434/api/embeddings"
MODEL = "nomic-embed-text"


def psql(sql: str, stdin: str | None = None) -> str:
    cmd = ["docker", "exec", "-i", DB, "psql", "-U", "companion", "-d", "companion", "-v", "ON_ERROR_STOP=1"]
    if stdin is None:
        cmd += ["-tAc", sql]
        inp = None
    else:
        inp = stdin
    out = subprocess.run(cmd, input=inp, capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"psql failed: {out.stderr[:500]}")
    return out.stdout


def read_messages() -> list[tuple[str, str]]:
    copy = (f"\\copy (SELECT id, content FROM ci.agent_memories "
            f"WHERE source='benchmark' AND user_id='{OWNER}') TO STDOUT WITH (FORMAT csv)")
    raw = psql(copy)
    rows = list(csv.reader(io.StringIO(raw)))
    return [(r[0], r[1]) for r in rows if len(r) >= 2 and r[1].strip()]


def embed(text: str) -> list[float]:
    body = json.dumps({"model": MODEL, "prompt": text}).encode()
    req = urllib.request.Request(OLLAMA, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())["embedding"]


def main():
    msgs = read_messages()
    print(f"read {len(msgs)} messages for owner")

    def one(m):
        mid, content = m
        return mid, embed(content)

    vecs = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        for i, (mid, v) in enumerate(ex.map(one, msgs), 1):
            vecs[mid] = v
            if i % 100 == 0:
                print(f"  embedded {i}/{len(msgs)}")
    print(f"embedded {len(vecs)} messages (dim={len(next(iter(vecs.values())))})")

    # Build one transaction: clear old message rows, insert fresh.
    lines = ["BEGIN;",
             f"DELETE FROM ci_search.embeddings WHERE user_id='{OWNER}' AND entity_type='message';"]
    for mid, v in vecs.items():
        vec = "[" + ",".join(repr(x) for x in v) + "]"
        lines.append(
            "INSERT INTO ci_search.embeddings "
            "(id, entity_type, entity_id, embedding, user_id, created_at, updated_at) VALUES "
            f"(gen_random_uuid(), 'message', '{mid}', '{vec}'::vector, '{OWNER}', now(), now());")
    lines.append("COMMIT;")
    psql("", stdin="\n".join(lines))

    n = psql(f"SELECT count(*) FROM ci_search.embeddings WHERE user_id='{OWNER}' AND entity_type='message';").strip()
    print(f"DONE — ci_search.embeddings now has {n} message rows for owner")


if __name__ == "__main__":
    main()
