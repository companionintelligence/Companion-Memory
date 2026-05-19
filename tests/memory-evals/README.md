# Memory Eval Harness

> **Status:** scaffolding only &nbsp;•&nbsp; **Plan:** [docs/architecture/plan/12-memory-evals.md](../../docs/architecture/plan/12-memory-evals.md)
>
> Measures whether the twin **remembers correctly** — recall@k, episodic dating, semantic-preference recall, forgetting precision, provenance coverage, etc. The goal is a measurable signal that catches regressions every time `memory`, `search-next`, `graph`, `intelligence`, `mcp`, `llm`, or `summary` code changes.

This commit lays down the structure and a runner stub. The real eval work — testcontainers wiring, a deterministic seed corpus, query authoring, CI integration — lands in follow-ups.

## Layout

```
tests/memory-evals/
├── README.md              — this file
├── run.ts                 — entrypoint: orchestrates corpus seed + suite run
├── score.ts               — per-suite scoring + scorecard writer
├── suites/                — one .yaml per suite (recall@k, episodic-dating, …)
├── corpus/                — seed generator(s); deterministic from a seed
└── fixtures/              — captured outputs for snapshot/regression checks
```

## Suites

Each `suites/<name>.yaml` follows:

```yaml
suite: episodic-dating
description: "When did I X?" → date within tolerance
threshold:
  pass: 0.80           # suite fails if score is below this
  regress_pp: 2        # PR fails if score drops > 2 pp from main
queries:
  - q: "When did I meet Sarah for lunch?"
    expect:
      kind: episodic
      occurred_at: 2026-03-12
      tolerance_days: 1
      must_include_source: true
```

## Running

```bash
# from the repo root
yarn memory-evals          # runs every suite
yarn memory-evals episodic # runs a single suite by name
```

`run.ts` writes a Markdown scorecard to `tests/memory-evals/.out/scorecard.md` and a JUnit XML to `tests/memory-evals/.out/junit.xml`. CI uploads both as build artifacts.

## What's *not* here yet

- **Seed corpus generator.** A small Faker-style generator that emits a year of John Smith's life into the schema, deterministic from a seed.
- **Real DB wiring.** Today `run.ts` is a stub that prints "no suites configured." The eval suite will use Testcontainers to spin a clean Postgres, run migrations, seed, then issue queries through the in-process MCP module (the canonical agent surface).
- **CI integration.** A GitHub Actions workflow that runs on every PR touching memory-critical paths and posts the scorecard as a PR comment.

These are tracked in [docs/architecture/plan/12-memory-evals.md §5](../../docs/architecture/plan/12-memory-evals.md).
