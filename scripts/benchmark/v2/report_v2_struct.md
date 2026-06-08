# Memory Benchmark v2 — Structured / Agentic-Memory tasks

> 37 questions over the same 100Q facts, probing what a knowledge graph is built for.
> Phase B answerer + LLM judge: ornstein-3.6-27b. Scored against the already-built stores.
> - temporal-update (20): current-vs-past value of facts that changed over time — binary LLM judge
> - enumeration (10): "list all X" — **deterministic SET RECALL** over the canonical gold members (fraction surfaced/named). No LLM judge — reproducible.
> - aggregation (7): "how many / which" — binary LLM judge

## Scores

| System | Answer | Storage | temporal-update (20) | enumeration (10) | aggregation (7) |
|---|---|---|---|---|---|
| naive | 24.9 | 24.2 | 14.0 | 4.9 | **6.0** |
| mem0 | **25.2** | 26.2 | 13.0 | 6.2 | **6.0** |
| ci_server | 24.1 | **27.0** | **15.0** | **7.1** | 2.0 |
| hindsight | 9.9 | 10.2 | 5.0 | 2.9 | 2.0 |
| openviking | 12.8 | 14.4 | 7.0 | 2.8 | 3.0 |
| holographic | 9.5 | 11.5 | 7.0 | 0.5 | 2.0 |

## Read

- **Enumeration — CI-Server wins (7.1/10), +45% over naive (4.9).** "List all of X's
  family / friends / employers" is the graph's structural advantage: it surfaces the
  *complete typed set*, where flat vector top-k misses members and buries them under
  distractors. This is a deterministic set-recall number — nothing to spin.
- **Temporal — CI-Server wins (15/20).** Typed edges + current/past framing track
  "what's true now" best as facts change.
- **Storage/retrieval completeness — CI-Server highest (27.0/37).** It surfaces the
  most relevant context overall.
- **Aggregation — CI-Server loses badly (2/7 vs 6/7).** The same rich-neighborhood
  retrieval that wins enumeration *overcounts* on "how many" questions: distractor-
  polluted edges (e.g. a misattributed "works at Umbrella Analytics") inflate counts.
  Honest weakness; fixable with retrieval precision/dedup, but real today.
- **Aggregate answer is still ~tied** (24–25) because the aggregation collapse cancels
  the temporal + enumeration wins. So the honest claim is **category-specific**:
  CI-Server leads on *structured/relational* memory (enumeration, temporal, retrieval
  completeness) — not "highest overall."
