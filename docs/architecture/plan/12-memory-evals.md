# 12 — Memory Eval Harness

> **Status:** draft &nbsp;•&nbsp; **Phase:** P0 &nbsp;•&nbsp; **Critical path:** yes
>
> Build a seedable corpus and a graded query suite that measures whether the twin remembers correctly — and run it in CI on every PR that touches memory.

---

## 1. Summary

Every change to embeddings, search-next scoring, consolidation rules, or LLM routing can silently degrade what the user can recall. As soon as agents depend on the twin, recall regressions become user-visible incidents. We need a measured signal, not vibes.

## 2. Current state

- No memory recall tests.
- Unit and integration tests exist in `tests/` but cover correctness of CRUD, not retrieval quality.

## 3. Target state

### 3.1 Suites

| Suite | What it measures | Pass criterion |
|---|---|---|
| `recall@k` | Given a seeded fact, the recall API returns it in top-k | recall@5 ≥ 0.9 on the seed corpus |
| `episodic-dating` | "When did I X?" returns a date within tolerance | day-accurate ≥ 0.8 |
| `semantic-preference` | "What kind of X do I prefer?" returns the stored preference | exact-match ≥ 0.85 |
| `procedural-detection` | After N weeks of consistent behavior, a Routine entity appears | precision ≥ 0.9 on synthetic patterns |
| `forgetting-precision` | "Do I know X?" where X is **not** present returns "I don't know" | false-positive rate ≤ 0.05 |
| `provenance-coverage` | Every recall returns ≥ 1 source | 100% |
| `relationship-inference` | Multi-hop "A is related to C via B?" returns the path | exact-match ≥ 0.7 |
| `policy-redaction` | An agent with a restrictive policy gets the expected redaction | 100% |

### 3.2 Seed corpus

A reproducible Faker-like generator in `tests/memory-evals/corpus/`:

- 1 user (John Smith — match `make seed`).
- 12 family/friend persons with stable relationships.
- 365 days of events: 3–5 calendar events/day, 2–10 messages/day, 1–3 captures/day.
- 50 stable preferences (coffee, foods, films, music).
- 5 routines (morning, commute, weekly review, gym, family call).
- 100 documents with embeddable chunks.
- Position track for half the days.

Generator is deterministic from a seed. Committed as a tiny SQL fixture + a generator script that creates the bulk.

### 3.3 Queries

Each suite has 50–200 graded queries. Format:

```yaml
suite: episodic-dating
queries:
  - q: "When did I meet Sarah for lunch?"
    expect:
      kind: episodic
      occurred_at: 2026-03-12
      tolerance_days: 1
      must_include_source: true
  - q: "When was my dentist appointment?"
    expect:
      multiple_allowed: true
      any_of: [2026-02-04, 2026-08-19]
```

### 3.4 Runner

`yarn test:memory-evals` (in `tests/memory-evals/`):

1. Bring up a clean Postgres via testcontainers.
2. Seed the corpus.
3. Run consolidation once.
4. Execute every query against the in-process MCP module (treats this as the canonical surface).
5. Score; emit a JUnit XML + a Markdown scorecard.
6. Fail CI if any suite is below threshold or below the previous PR's score by > 2 pp.

Run in CI on every PR that touches: `memory`, `search-next`, `graph`, `intelligence`, `mcp`, `llm`, `summary` paths.

### 3.5 Drift tracking

A `eval_runs` table (in a separate eval DB, not the user's) records each run's scores tied to git SHA + provider config, so we can chart "did the OpenRouter provider degrade recall?" over time.

## 4. Branch disposition

| Branch | Role |
|---|---|
| `copilot/add-llm-red-team-prompt-foo` | Promptfoo baseline; **layer this eval on top of it** rather than replacing. See [19](19-red-teaming.md). |

## 5. Phased steps

| # | Increment |
|---|---|
| 1 | `tests/memory-evals/` scaffolding + testcontainers + seed corpus generator |
| 2 | `recall@k` suite + 50 queries |
| 3 | `episodic-dating` + `semantic-preference` suites |
| 4 | `forgetting-precision` (the **most important** for trust) |
| 5 | `provenance-coverage` (depends on [08](08-provenance-lineage.md)) |
| 6 | `procedural-detection` (depends on [03](03-memory-model.md) consolidation) |
| 7 | `policy-redaction` (depends on [09](09-privacy-consent.md)) |
| 8 | CI integration with scorecard comment on PRs |
| 9 | Drift dashboard |

## 6. Risks

| Risk | Mitigation |
|---|---|
| Corpus is too synthetic | Mix with anonymized real samples behind a flag; opt-in. |
| Evals flake on LLM nondeterminism | Pin temperature=0 + seed where supported; allow `any_of` matches; retry budget. |
| Thresholds become rubber stamps | Track absolute score *and* delta; deltas are the gate. |
| CI runtime explodes | Sample 25% of queries on every PR; full suite nightly on main. |

## 7. Eval / acceptance

- Every PR touching memory-critical paths shows a scorecard delta in the comments.
- A change that lowers `forgetting-precision` is blocked at merge.
- The drift dashboard shows score-by-provider over time.
- Manual reviewers can re-run an eval against a candidate change locally in under 10 minutes.
