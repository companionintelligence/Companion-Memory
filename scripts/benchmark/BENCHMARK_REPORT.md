# CI-Server Memory Benchmark — Report, Methodology & Critical Analysis

> **Read this first.** This document explains what the benchmark measures, how it
> works, every result we have so far, and — most importantly — **the ways the
> benchmark is biased and where the numbers cannot be taken at face value.** The
> headline "naive RAG beats Mem0 and Hindsight" is **largely a measurement
> artifact**, not a real finding. Details in §7.

---

## 1. Purpose

Compare CI-Server's graph-backed memory against other memory systems on the same
synthetic user, same questions, same scorer — to find where the graph helps,
where it doesn't, and what to fix.

Everything runs **fully local**: extraction LLM and the judge are
`gemma-4-31b-it-abliterated` served by **LM Studio** at `192.168.0.202:1234`;
embeddings are `nomic-embed-text` via **Ollama**. No cloud calls.

## 2. How it works

```
persona JSON ──> for each system:
   setup() ──> ingest(msg) per user message ──> flush() ──> search(question) ──> score
```

- **Persona**: a synthetic user defined as (a) conversational `sessions` whose
  user turns are ingested, and (b) `eval_questions`, each with a gold `answer`,
  `keywords`, and a `category`.
- **Adapter** (one per system, `adapters/`): `ingest(text)`, `flush()`,
  `search(query) -> str`. The returned string is the "retrieved context."
- **Scorer**: decides whether the retrieved context answers the question.

## 3. Systems under test

| System | What it does | How it's wired here |
|---|---|---|
| **CI-Server (graph)** | LLM extracts entities+relationships into a Postgres knowledge graph; recall = keyword/embedding search + 1-hop query-conditioned graph expansion | `/api/memory/note` → `/api/memory/compact` → `/api/memory/recall`; extraction LLM = LM Studio gemma |
| **Naive RAG (vector)** | No extraction. Embed each raw message; KNN top-k at query time; return the raw sentences | stdlib + Ollama `nomic` embeddings; cosine top-10 |
| **Mem0 (vector)** | LLM consolidates messages into deduplicated "memories" in a Chroma vector store | `mem0ai==2.0.4`; LLM via a proxy → LM Studio gemma; embedder = Ollama `nomic` |
| **Hindsight (retain/recall)** | Self-hosted agent memory (retain/recall/reflect) with consolidation + belief networks | Docker `ghcr.io/vectorize-io/hindsight`, `lmstudio` provider → same gemma; embedder = its local `bge-small` |

**Fairness control:** the *extraction/consolidation LLM* is held constant
(gemma-4-31b) across CI-Server, Mem0, and Hindsight, and the embedder is nomic
for everyone except Hindsight (which uses its built-in bge-small — see §7.4).

> ⚠️ LM Studio rejects `response_format:{type:"json_object"}` (wants `json_schema`).
> Mem0 hardcodes `json_object`, so it talks to LM Studio through
> `lmstudio_proxy.py`, which rewrites that field. This keeps the model constant
> but is one of several ways we bend these tools out of their tested setup (§7.4).

## 4. Personas / regimes

| Persona file | Subject | #Q | Messages | What it stresses |
|---|---|---|---|---|
| `jordan_rivera.json` | Jordan | 20 | ~25 | original smoke test (keyword scorer) |
| `priya_sharma.json` | Priya | 22 | ~32 | temporal-update + multi-hop, small |
| `priya_sharma_large.json` | Priya | 22 | 180 | + 160 hard-negative distractors |
| `max_turnquist_50_large.json` | **Max** (canonical account self node) | 50 | 342 | + 300 distractors, 50 questions |
| `max_multichunk_large.json` | Max | 18 | 273 | answers **split across distant messages** (synthesis) |

**Why "Max":** CI-Server anchors first-person facts to the account's canonical
self node (`ci.users.entity_id`). The benchmark account's canonical node is
"Max Turnquist," so the persona was recentered onto Max and `--reset` does a full
graph wipe (preserving that one node) for a clean slate.

**Hard negatives:** distractors are *semantic* near-misses ("my coworker Dan
plays trumpet" competes with the one real "violin" fact), not random noise — so
fixed top-k retrieval can't trivially surface the answer.

## 5. Scoring

Two scorers (`--scorer`):

- **keyword** (default): hit if any expected keyword appears in the retrieved
  text. Deterministic and reproducible, but **rewards verbatim text and punishes
  paraphrase/consolidation** — a raw-chunk dump trivially wins.
- **llm**: an LLM judge (same gemma) is given `(question, gold answer, retrieved
  context)` and decides if the context supports the answer. Credits paraphrase,
  penalizes contradiction. Includes a **subject-grounding rule**: "the user" /
  the subject's name refer to the same person, so a memory phrased "the user
  likes X" counts as answering "what does Max like?"

All headline numbers below use the **LLM judge** unless marked (keyword).

## 6. Results

### 6.1 Progression (CI-Server hardening, single system)
0/20 → 3-4/20 → 8 → 12 → 13 (small Priya, keyword) as we fixed: extraction model
(gemma3:1b → gemma-4-31b), entity-type casing, the generic search-index listener
(Item/Content/Event were never indexed), OR-joined keyword/boosted search, query-
conditioned graph expansion, self-node anchoring, and richer relationship vocab.

### 6.2 Small vs large (Priya, 22Q, LLM judge)
| | small (32 msg) | large (180 msg) |
|---|---|---|
| Naive RAG | 21/22 (95%) | 10/22 (45%) |
| CI-Server | 15/22 (68%) | 9/22 (41%) |
| Hindsight | — | 1/22 (5%) |
| Mem0 | 0/22 (0%) | 0/22 (0%) |

### 6.3 Scaled (Max, 50Q, 342 msg, LLM judge)
| System | Score | flat | relational | multi-hop | temporal |
|---|---|---|---|---|---|
| Naive RAG | **35/50 (70%)** | 13/20 | 9/10 | 5/7 | 8/13 |
| CI-Server | **22/50 (44%)** | **14/20** | 4/10 | 0/7 | 4/13 |
| Mem0 | 0/50 (0%) | 0 | 0 | 0 | 0 |
| Hindsight | (pending) | | | | |

Note: CI-Server **beats** naive on flat-recall and specifically on the
distractor-*contested* atomic facts (instrument, cat, breed) — its normalized
entity is a clean record while naive's top-k drowns in the 18 instrument
distractors. CI-Server loses on relational/multi-hop (recall ranking, §9).

---

## 7. CRITICAL ANALYSIS — why the numbers are misleading

**The headline "naive KNN beats well-funded memory tools" is mostly an artifact
of this benchmark. Do not trust the Mem0/Hindsight scores as a verdict on those
products.** Concrete reasons:

### 7.1 The task is the ideal case for verbatim KNN
Every persona fact is stated in **one clean sentence**, and each question asks
for that one fact. "Retrieve the sentence that says X" is exactly what raw
KNN is best at — and exactly what consolidation throws away. Memory tools
deliberately *distill* (lossy) because they target long, redundant, multi-session
chat history, not a fact lookup. So KNN winning here says little about real use.

### 7.2 "Naive" is not dumb — it's KNN + a strong reasoner
The naive adapter returns ~10 raw sentences and the **LLM judge does the
reasoning** (multi-hop chaining, current-vs-stale) at read time. So we're really
comparing **"raw text + smart reader"** vs **"pre-digested memory + smart
reader."** The raw-text pipeline keeps every detail for the reader; the digesting
tools hand the reader less. On a small corpus that fits in top-k, raw text wins
by construction.

### 7.3 Mem0's 0/50 is a HARNESS RETRIEVAL BUG, not memory quality ⭐
This is the most important caveat. We inspected Mem0's actual store:

- From 342 messages, Mem0 consolidated **34 clean, accurate, deduplicated
  memories** and **correctly filtered out all 300 distractors.** Examples:
  - *"User's best friend Lena lives in San Francisco and works at Stripe"*
  - *"User's sister Anita is an architect"*, *"...brother-in-law Raj is a cardiologist"*
  - *"User's niece Mira is the daughter of User's sister Anita"*
  - *"User moved from Portland to Denver"*, *"left Northwind... now at Cobalt Robotics"*
  These contain the answer to **nearly every one of the 50 questions.** Mem0's
  consolidation is arguably the **best-performing component in the whole
  benchmark.**
- **But Mem0's search returns the wrong memories.** Direct probe — query *"What
  instrument does Max play?"* returned memories about Professor Okafor, an Acme
  Freight client, and the engagement to Sam — **not** the *"User picked up the
  violin"* memory that exists in the store. The answer memories are present and
  simply not retrieved.
- This is *systematic*, not random (random-of-34 would hit some answers across 50
  questions; we got 0). The signature points to **query/document embedding-space
  misalignment** — most likely Mem0's Ollama embedder applying `nomic`'s
  asymmetric `search_query:` / `search_document:` prefixes inconsistently, while
  the naive adapter embeds both sides plainly and so works fine.

**Conclusion: Mem0's 0 reflects our integration (embedder/retrieval config), not
Mem0. Its memory layer outperformed everything; we then failed to read from it.**
Fix direction: give Mem0 a symmetric embedder (or the matching nomic prefixes, or
LM Studio's embedding endpoint) and re-test.

### 7.4 We force these tools off their tested path
- **Local abliterated model via a rewriting proxy.** Mem0 and Hindsight are
  built and tuned against frontier models (GPT-4o/Claude) with reliable
  structured **tool/function calling** for their memory CRUD decisions.
  gemma-4-31b on LM Studio (through a `response_format` rewrite proxy) is far from
  that; their memory-management prompts may degrade in ways the vendors never see.
- **Embedder mismatch (Hindsight).** Hindsight uses its built-in `bge-small`,
  not nomic — a different retrieval space than the others.
- **Possibly the wrong Hindsight API.** We call `recall()` (raw memory
  retrieval) for parity with the others. Hindsight's intended Q&A path is
  `reflect()` (it generates an answer). Using `recall` may understate it.

### 7.5 Hindsight runtime
Hindsight took **47 min for 180 messages** (~16s/message: a recall + large-context
consolidation LLM call per `retain`, serialized at `MAX_CONCURRENT=1`). That's a
real operational data point for *local* use, but it also means our patience, not
just its quality, shaped the runs.

### 7.6 What this benchmark does and does NOT measure

**Does measure:** single-fact retrieval precision under distractor load, with a
fixed local model; whether a system can surface one specific stored fact when
asked.

**Does NOT measure (but pretends to):**
- Real memory-tool value: long multi-session histories, redundancy, contradiction
  resolution over time, personalization, latency/cost at production scale.
- Anything where you *can't* just retrieve raw chunks (we tried to build this —
  `max_multichunk_large.json` — see §10).
- The tools on their supported models/configs.

## 8. Honest conclusions

1. **CI-Server's real, fair wins:** normalization beats raw KNN on
   distractor-contested atomic facts (flat-recall 14/20 vs 13/20); the write-path
   fixes (specific relationship types like `SIBLING_OF`, canonical self-node
   anchoring) are correct and verified in the graph.
2. **CI-Server's real gap:** relational/multi-hop **recall ranking** under
   distractor density — the right facts are often in the graph but out-ranked by
   distractor neighbours (see §9).
3. **The Mem0/Hindsight scores are not trustworthy** as product verdicts; at
   least Mem0's is a demonstrated harness retrieval bug sitting on top of
   excellent memory quality.
4. **Naive RAG is a deceptively strong baseline** *for this task shape*, because
   the task is verbatim lookup and the judge supplies the reasoning.

## 9. CI-Server's actual frontier (from per-question diagnosis)
- `SIBLING_OF(Max → Anita)` etc. are correctly written, but graph expansion's
  Stage-1 type-prune embeds the *whole verbose question*, diluting the relation
  signal so the right edge type can fall below the floor.
- Same-type distractor crowding: "best friend Lena" and "my friend Priscilla" are
  both `FRIENDS_WITH`, so the real one gets buried. Needs edge strength / "best"
  qualifier + ranking that uses it.

## 10. Recommendations

1. **Fix the Mem0 retrieval integration** (embedder symmetry / nomic prefixes)
   and re-run — its consolidation deserves a fair retrieval test.
2. **Use Hindsight's `reflect()`** (or at least test both) and account for the
   bge-small embedder.
3. **Lean into the multi-chunk regime** (`max_multichunk_large.json`): answers
   spread across distant messages + aggregation questions whose answer is never
   stated verbatim. This is the only regime that can't be won by raw retrieval,
   and the fair place to show graph/consolidation value.
4. **Add an LLM-judge fairness pass** that ignores subject-name phrasing (done)
   and consider scoring *generated answers* (reflect-style) for all systems, not
   just retrieved chunks.
5. Treat keyword scoring as a regression check only; use the LLM judge for
   cross-architecture comparison.

---
*Generated during the CI-Server benchmark session. Numbers are from local runs on
gemma-4-31b-it-abliterated (LM Studio) + nomic-embed-text (Ollama). The four-way
runs on the 50-question and multi-chunk personas were still completing at the time
of writing; `report_max50_4way.md` and `report_multichunk_4way.md` hold the
machine-generated tables.*
