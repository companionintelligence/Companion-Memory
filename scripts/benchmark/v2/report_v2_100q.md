# Memory Benchmark v2 — Max Turnquist

> 100 questions · containerized · retrieval-augmented answerer · LLM judge

## Scores

| System | Answer | Storage | flat-recall | relational | multi-hop | temporal-update |
|---|---|---|---|---|---|---|
| naive | **79/100** | 78/100 | 28/34 | 22/22 | 15/22 | 14/22 |
| mem0 | **78/100** | 79/100 | 24/34 | 21/22 | 19/22 | 14/22 |
| hindsight | **25/100** | 21/100 | 7/34 | 9/22 | 4/22 | 5/22 |
| openviking | **47/100** | 56/100 | 18/34 | 6/22 | 15/22 | 8/22 |
| ci_server | **75/100** | 78/100 | 26/34 | 19/22 | 12/22 | 18/22 |

> Setup: 90 canonical facts + 400 distractors (490 msgs, top-10 ≈ 2% coverage).
> Phase A ingest/extraction on gemma-4-31b-it-abliterated (all systems, equal footing);
> Phase B answerer + LLM judge on ornstein-3.6-27b (held constant for fairness).
> Embeddings: nomic-embed-text for all except hindsight (its built-in bge-small — minor confound).
> Caveat: hindsight scored serially (--answer-concurrency 1); its recall client 500s under
> concurrent calls. The 0/100 from the concurrent run was an artifact, not a result.

## Timing (memory-system cost)

Times below are the work the memory layer itself does. The answer phase is the
shared ornstein answerer + LLM judge (identical harness for every system), so it
is NOT a per-system cost and is excluded.

| System | Ingest (490 msgs) | Answer phase (100 Q) | Recall latency / query |
|---|---|---|---|
| naive | **16 s** (sequential) | ~13 m (concurrency 4) | ~0.06 s |
| mem0 | 14 m 36 s (sequential) | ~13 m (concurrency 4) | ~0.12 s |
| ci_server | 16 m 10 s (sequential) | ~13 m (concurrency 4) | ~0.08 s |
| hindsight | **35 m** *with* server concurrency=4; **~2.3 h sequential** | **37 m (forced serial)** | ~1.16 s (not concurrency-safe) |

**Fairness note — hindsight has two concurrency handicaps the others don't:**
1. *Ingest:* naive/mem0/ci_server all ingest **sequentially**. To make hindsight
   viable I gave it `HINDSIGHT_API_LLM_MAX_CONCURRENT=4` + async retain, getting
   35 min. Under the **same sequential terms** it was ~17 s/fact ≈ **2.3 hours**.
   Even with the boost it was the slowest ingest; the 35-min figure flatters it.
2. *Answer:* its recall client 500s under concurrent calls, so it must answer
   **serially** (37 min/100 Q) while the others run at concurrency 4 (~13 min).

So hindsight's true comparable wall-clock is **~2.5–3 hours**, vs ~30 min
(ingest + answer) for the others. naive/mem0/ci_server ingest = same gemma-4-31b
extractor; naive just embeds (no LLM). Recall latency = median of 3 warm
`/retrieve` calls (naive's ~1 s cold first call excluded).
