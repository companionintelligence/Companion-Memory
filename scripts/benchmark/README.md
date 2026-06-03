# Memory System Benchmark

Head-to-head comparison of CI-Server's graph-backed memory against other
memory systems (Mem0, Honcho, …) on the same synthetic persona, same
questions, same scorer.

## Quick start

```bash
cd scripts/benchmark
pip install -r requirements.txt

# CI-Server only (no extra deps)
CI_SERVER_URL=http://localhost:8642 \
CI_SERVER_TOKEN=<your-api-key> \
python benchmark.py --systems ci_server --out report.md

# Head-to-head vs Mem0
CI_SERVER_URL=http://localhost:8642 \
CI_SERVER_TOKEN=<your-api-key> \
python benchmark.py --systems ci_server,mem0 --out report.md

# Clean slate (drops prior source='benchmark' fragments and derived
# entities via docker exec into the postgres container — dev use only)
python benchmark.py --systems ci_server --reset
```

### Pointing compaction at a remote LLM (LM Studio / vLLM / llama.cpp)

By default, `MemoryCompactionService` uses the local Ollama instance for
entity extraction. If a beefier machine on your LAN is running an
OpenAI-compatible server, set these env vars on the API process (not on
the benchmark — the API is what calls the LLM):

```bash
EXTRACTION_LLM_URL=http://192.168.0.202:1234         # no trailing /v1
EXTRACTION_LLM_MODEL=<id-from-/v1/models>            # e.g. qwen3-coder
EXTRACTION_LLM_API_KEY=...                            # optional (LM Studio: usually unset)
EXTRACTION_LLM_TIMEOUT_MS=120000                      # optional, default 2min
```

When `EXTRACTION_LLM_URL` is set, compaction skips Ollama entirely and POSTs
to `${URL}/v1/chat/completions` with `response_format: {type: "json_object"}`.
Unset to fall back to Ollama. Embeddings still come from Ollama either way.

## How it works

1. **Persona** — `personas/jordan_rivera.json` defines a synthetic user with:
   - 20 ground-truth facts
   - 5 simulated conversation sessions that reveal those facts naturally
   - 20 eval questions across three categories

2. **Adapters** — each system gets a thin wrapper (`adapters/`) with three
   operations: `ingest(text, session_id)`, `flush()`, `search(query) → str`.

3. **Scoring** — keyword match: a question is a **hit** if the retrieved
   context contains at least one expected keyword (case-insensitive).
   This is deterministic and reproducible. No LLM judge needed.

4. **Report** — Markdown table with per-system scores broken down by category.

## Question categories

| Category     | Description                                           | Why it matters                        |
|--------------|-------------------------------------------------------|---------------------------------------|
| `flat-recall`| Single-entity facts stated directly in conversation   | Both systems should do well here      |
| `relational` | Requires connecting two entities (person ↔ employer)  | Graph advantage expected              |
| `temporal`   | Facts that change over time or require update         | Tests contradiction resolution        |

## Adding a new system

1. Create `adapters/your_system.py` implementing `MemoryAdapter` (see `adapters/base.py`)
2. Import it in `adapters/__init__.py`
3. Add the key to `adapter_map` in `benchmark.py`
4. Run with `--systems ci_server,your_system`

## Interpreting results

- **flat-recall gap** — if CI-Server trails here, the recall endpoint or
  compaction extraction quality needs work.
- **relational gap** — this is where the graph should win vs flat vector stores.
  If not, investigate whether relationships are being extracted and indexed.
- **temporal gap** — if CI-Server wins here, it means the entity upsert/merge
  logic is correctly overwriting stale facts rather than appending them.

## Known limitations

- Keyword scoring rewards lexical overlap, not semantic understanding.
  A system that paraphrases correctly may score lower than it deserves.
- CI-Server's `flush()` polls until `processedAt` is set on all fragments,
  which includes Ollama LLM time. Run times will be longer than Mem0's
  synchronous indexing.
- The persona is fictional and small (20 facts). Real-world results at
  scale may differ.
