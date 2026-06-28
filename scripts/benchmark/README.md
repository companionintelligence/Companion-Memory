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
    regression.py           --baseline gate: compare two JSON reports
    generate_persona.py     parametric persona inflator (replaces 7 spike scripts)
    judge_cache.py          persistent (q, ctx, model) → verdict cache for the LLM judge
    adapters/
      base.py               MemoryAdapter contract
      ci_server.py          CI-Server adapter (shipped endpoints only)
      hindsight.py          Hindsight adapter (retain/recall; opt-in deps)
      mem0.py               Mem0 adapter (local Ollama + Chroma; opt-in deps)
      naive.py              top-K BoW retrieval baseline
  personas/
    jordan_rivera.json      canonical persona (5 sessions, 20 questions,
                              3 categories: flat-recall / relational / temporal)
    jordan_rivera_long.json long-context variant (55 sessions / 175 messages,
                              originals interleaved with 50 noise sessions —
                              stresses retrieval at scale)
    priya_sharma.json       second persona stressing multi-hop, temporal-update,
                              and absence (5 sessions, 16 questions, 5 categories)
  baselines/                committed JSON baselines used by the CI regression gate
  tests/                    pytest suite (113 tests)
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

## Use as a CI gate (regression baseline)

Save the current numbers as a baseline, then re-run to detect regressions:

```bash
# 1) Record the baseline
python -m benchmark --systems ci_server,naive \
  --persona personas/jordan_rivera.json \
  --out reports/baseline.md
git add reports/baseline.json && git commit -m "chore: baseline benchmark"

# 2) Re-run later — non-zero exit if any score regresses beyond --tolerance
python -m benchmark --systems ci_server,naive \
  --persona personas/jordan_rivera.json \
  --baseline reports/baseline.json \
  --tolerance 0.05 \
  --out reports/run-$(date +%F).md
```

The regression report distinguishes `regression` (drop beyond tolerance — fails
the gate) from `improvement`, `stable`, `error_introduced` / `error_resolved`,
and `missing` (system or category present in only one report — usually means
the baseline needs refreshing). Tolerance is in score-ratio units;
`--tolerance 0.05` means "fail if any category drops by more than 5 pp".

## Personas

Two canonical personas, designed so the question mix surfaces *architectural*
differences rather than just rewarding raw retrieval:

| Persona | Categories |
|---|---|
| `jordan_rivera.json` | `flat-recall`, `relational`, `temporal` |
| `priya_sharma.json` | `flat-recall`, `relational`, `multi-hop`, `temporal-update`, `absence` |

The Priya categories are where a raw-retrieval system loses:

- **`multi-hop`** — answer requires combining facts from ≥2 separate sessions.
- **`temporal-update`** — fact changed over time; correct answer is the *current*
  value. A system that dumps both old and new without distinguishing them is
  graded as a miss by the LLM judge.
- **`absence`** — persona has no answer. A correct memory system returns
  nothing relevant; a hallucinating one invents one.

On the canonical personas the naive baseline gets 65 % on Jordan but only 38 %
on Priya, with 0 % on `absence` — that gap is the suite's signal-to-noise
floor for cross-architecture comparison.

## Inflate a persona

The spike branch had seven `build_*.py` one-off scripts that produced 30+
persona variants (`_base`/`_large`/`_50_large`/…). They collapse to one
parametric generator:

```bash
python -m benchmark.generate_persona \
  --base personas/jordan_rivera.json \
  --noise-sessions 50 \
  --messages-per-noise-session 3 \
  --position interleave \
  --seed 42 \
  --out personas/jordan_rivera_50.json
```

`--seed` makes runs reproducible; noise sessions are deliberately semantically
distant from any persona fact. `--position` controls where noise lands:

- `append` (default) — noise after originals → stresses **recency bias**.
- `prepend` — noise before originals → stresses **primacy bias**.
- `interleave` — seeded shuffle of the union → uniform dilution, no positional bias.

The shipped `personas/jordan_rivera_long.json` is generated this way
(`--noise-sessions 50 --position interleave --seed 17`), placing the canonical
facts at sessions 11/18/29/47/53 of 55.

## Caching the LLM judge

LLM-judge runs are slow and token-priced, but verdicts are deterministic in
`(question, gold answer, retrieved context, judge model)`. Pass `--judge-cache`
to persist them and short-circuit the LLM on re-runs:

```bash
JUDGE_URL=http://localhost:1234 JUDGE_MODEL=qwen2.5-7b \
python -m benchmark \
  --persona personas/jordan_rivera.json \
  --systems ci_server,naive \
  --scorer llm \
  --judge-cache .judge_cache.json \
  --out report.md
```

A second run with the same inputs touches zero of the LLM endpoint. Changing
the persona's gold answer, the judge model, or the retrieved context (i.e. the
memory system's behaviour changed) invalidates the entry and forces a re-judge.

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
