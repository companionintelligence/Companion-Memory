# Memory System Benchmark

Head-to-head comparison of CI-Server's memory against alternative memory systems
on the same synthetic persona, the same questions, and the same scorer.

This is the production-ready refactor of the benchmark prototype on PR #1453's
spike branch. It is **decoupled from that spike's backend changes**: the
`ci_server` adapter only uses endpoints that exist on `main`
(`/api/memory/context`, `/api/memory/recall`, `/api/memory/write` with the
`/api/memory/note` 404 fallback the harness plugins already use). You can run it
against a CI-Server checked out at `main` today.

## Layout

```
scripts/benchmark/
  benchmark/                package
    __main__.py             CLI entrypoint  (python -m benchmark …)
    schema.py               persona / question / result types + validator
    scoring.py              keyword + LLM-judge scorers
    runner.py               the run_system / run_all lifecycle
    reporter.py             Markdown + JSON report builders
    generate_persona.py     parametric persona inflator (replaces 7 spike scripts)
    adapters/
      base.py               MemoryAdapter contract
      ci_server.py          CI-Server adapter (shipped endpoints only)
      naive.py              top-K BoW retrieval baseline
  personas/
    jordan_rivera.json      canonical persona (5 sessions, 20 questions,
                              3 categories: flat-recall / relational / temporal)
  tests/                    pytest suite (~50 tests)
  requirements.txt          (none for runtime; pytest for tests)
  pyproject.toml
```

## Run a benchmark

```bash
cd scripts/benchmark
pip install -r requirements.txt           # installs only pytest

# 1) Smoke test — naive baseline only, no CI-Server needed
python -m benchmark \
  --persona personas/jordan_rivera.json \
  --systems naive

# 2) Head-to-head — CI-Server vs naive, keyword scorer
CI_SERVER_URL=http://localhost:8642 \
CI_SERVER_TOKEN=<your-api-key> \
python -m benchmark \
  --persona personas/jordan_rivera.json \
  --systems ci_server,naive \
  --out report.md

# 3) Fair scoring — point at any OpenAI-compatible Chat Completions endpoint
JUDGE_URL=http://localhost:1234 JUDGE_MODEL=qwen2.5-7b \
python -m benchmark \
  --persona personas/jordan_rivera.json \
  --systems ci_server,naive \
  --scorer llm \
  --out report.md
```

The CLI writes a Markdown report (overall table + per-question detail) and a
sibling `.json` for diffing across CI runs. It exits non-zero if **any** system
errored — useful as a CI gate.

## Inflate a persona

The spike branch had seven `build_*.py` one-off scripts that produced 30+
persona variants (`_base`/`_large`/`_50_large`/…). They collapse to one
parametric generator:

```bash
python -m benchmark.generate_persona \
  --base personas/jordan_rivera.json \
  --noise-sessions 50 \
  --messages-per-noise-session 3 \
  --seed 42 \
  --out personas/jordan_rivera_50.json
```

The `--seed` makes runs reproducible; the noise sessions exist only to stress
recall against an inflated corpus, so they're deliberately semantically distant
from any persona fact.

## Add a memory system

1. Implement `benchmark/adapters/base.MemoryAdapter` — five methods:
   `name`, `setup(user_id)`, `ingest(text, session_id)`, `flush()`,
   `search(query) -> str`, `teardown()`.
2. Register it in `benchmark/adapters/__init__.py`'s `ADAPTERS` dict — or call
   `register_adapter()` from a plug-in script.
3. (Optional) Add a unit test that drives `setup → ingest → search → teardown`
   against a stubbed transport.

The runner already swallows adapter exceptions and records them as an `error`
field on the result, so a broken backend can't crash a multi-system run.

## Scorers

| Scorer | Reproducible? | Fair to extraction-based memory? | Needs network? |
|---|---|---|---|
| `keyword` (default) | yes | no — rewards verbatim text | no |
| `llm` | depends on judge model + temperature | yes — credits paraphrase | yes (OpenAI-compatible) |

Use `keyword` for regression (cheap and deterministic); use `llm` for
cross-architecture comparison (compares meaning, not surface form).

## Tests

```bash
pytest                                    # ~50 unit tests, no network
```

CI runs the unit tests on every PR. Live integration tests against a real
CI-Server + LLM judge are **opt-in** — they need credentials and external
services so they're not part of the standard PR check.

## What was dropped from PR #1453

- 7 `build_*.py` one-off persona scripts → 1 parametric `generate_persona.py`.
- 30+ persona variants → 1 canonical persona (inflate on demand).
- 10+ stale `report_*.md` files and a `v2/` LaTeX directory (output artifacts,
  not source).
- `lmstudio_proxy.py`, `diagnose.py` (one-off dev tools).
- Coupling of the `ci_server` adapter to spike-only endpoints
  (`/api/memory/compact`, polling via `docker exec`).

What was kept and improved: the `MemoryAdapter` contract, the keyword and
LLM-judge scorers, the persona JSON schema, the runner skeleton, and the
`naive`/`ci_server` adapters. The remaining adapters from the spike (`mem0`,
`hindsight`, `honcho`) are easy follow-ups — drop them in `benchmark/adapters/`,
register in the `ADAPTERS` dict, add a test.
