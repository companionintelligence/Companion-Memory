# Memory-System Benchmark — CI-Server vs. Mem0, Hindsight, OpenViking, Naive RAG

*Local-only, head-to-head evaluation of agent memory systems on a single synthetic
persona. Fully reproducible; no cloud calls.*

---

## 1. TL;DR

- On a **100-question flat/relational corpus**, the top three are a statistical tie:
  **naive 79 · mem0 78 · ci_server 75** (answer accuracy / 100). Then
  **Holographic 69** (a no-LLM keyword store — the efficiency dark horse),
  **OpenViking 47**, **Hindsight 25**.
- On **structured / relational / temporal** tasks — the workloads a knowledge graph
  is actually *for* — **CI-Server leads** (best temporal, best enumeration, best
  retrieval completeness), at top-tier query latency.
- Plain vector RAG is brutally cost-effective for one-shot fact lookup; the graph's
  edge shows up on relationship traversal, "what's true now," and "list all X."
- **Honest weaknesses:** CI-Server's rich retrieval hurts it on counting
  (aggregation) and on "does X exist?" precision; its ingest is mid-pack; multi-hop
  trails mem0's consolidation.

---

## 2. Method

**Corpus.** One synthetic persona ("Max Turnquist"): **90 canonical facts**
authored by hand (people, places, employers, relationships, multi-hop chains,
facts that change over time), then buried under **400 distractor messages** (the
same topics about *other* people, plus low-signal filler) so a fixed top-k
retriever can't trivially win. Total **490 messages; top-10 ≈ 2% coverage.**

**Uniform contract.** Every system runs in its own container exposing the same HTTP
surface: `reset · ingest(text) · flush · retrieve(query) · answer(question)`. The
orchestrator only speaks this contract — no vendor SDKs run on the host.

**Two-phase, fair-by-construction.**
- **Phase A — ingest/extraction:** every system ingests the identical corpus using
  the **same extractor LLM (gemma-4-31b-it-abliterated)** and **same embeddings
  (nomic-embed-text)**. (Hindsight uses its built-in bge embedder — a flagged minor
  confound.) This isolates the *memory architecture*, not the model.
- **Phase B — answer + judge:** a **single, constant** retrieval-augmented answerer
  and LLM judge (**ornstein-3.6-27b**) is used for *all* systems, so we compare
  memory layers, not answer-writers.

**Two scored dimensions (per question):**
- **Answer** — did the constant answerer, given the system's retrieved context,
  produce a correct final answer? (LLM-judged, or deterministic for enumeration.)
- **Storage** — was the gold fact actually *present in the raw retrieved context*?
  This isolates "did the memory store + surface the fact" from "did the answerer
  phrase it well." A system can have high storage but lower answer (retrieved it
  but the answerer fumbled) or vice-versa.

---

## 3. Question classes — what each probes and how it's scored

There are **three suites** (a broad 100Q suite, a structured suite, and an absence
suite), spanning **nine classes**. Every gold answer is grounded in exactly one
canonical fact (verified by a grounding check), so a miss is a retrieval/answer
failure, not a missing fact.

### Suite A — Broad recall (100 questions)

**1. `flat-recall`** *(34 q)* — a single atomic fact stated **once** about the user.
- *Example:* "What instrument does Max play?" → **violin**.
- *Probes:* can the system store one stated fact and surface it from under 400
  distractors (e.g. other people's instruments)?
- *Scored:* LLM answer-judge (correct/incorrect) + storage-judge (gold fact present
  in retrieved snippets). Paraphrases count; "I don't know"/wrong = incorrect.
- *Why it matters:* vector RAG's home turf — the "find this one line" case.

**2. `relational`** *(22 q)* — a fact one relationship-hop from the user.
- *Example:* "Who is Max's sister?" → **Anita**; "Where do Max's parents live?" →
  **Portland**.
- *Probes:* resolving a named relation and retrieving that entity's attribute.
- *Scored:* LLM answer + storage judge.

**3. `multi-hop`** *(22 q)* — requires chaining **two or more** relationships.
- *Example:* "What does Max's brother-in-law do for work?" → **cardiologist**
  (Max → sister Anita → husband Raj → occupation); "Where does Max's best friend
  work?" → **Stripe** (Max → Lena → employer).
- *Probes:* relationship traversal / whether the system co-locates the bridge fact
  and the leaf fact so the answerer can connect them.
- *Scored:* LLM answer + storage judge. (Graph 1-hop expansion vs. consolidation
  that fuses related facts into one record both help here.)

**4. `temporal-update`** *(22 q)* — facts that **changed over time**; asks for the
current (or explicitly prior) value.
- *Example:* "What city does Max currently live in?" → **Denver** (not the prior
  Portland); "What company did Max work for before his current job?" →
  **Northwind Logistics**.
- *Probes:* supersession — when multiple versions of a fact exist in the corpus, can
  the system surface the *right* one? Flat stores keep every version and lean on the
  answerer to guess; typed/recency-aware stores disambiguate.
- *Scored:* LLM answer + storage judge.

### Suite B — Structured / agentic (37 questions)

**5. `temporal-update`** *(20 q)* — same as class 4 but **both directions** (current
*and* prior value of each changed fact), to stress supersession harder.

**6. `enumeration`** *(10 q)* — "**list all X**" set queries.
- *Example:* "List all of Max's family members." → gold set {Anita, Deepak, Sunita,
  Raj, Mira, Felix, Sam, Nana Rose, Bashir}.
- *Probes:* returning the **complete typed set** — the graph's structural strength.
  Flat top-k structurally misses members and pads with distractors; it has no notion
  of "all edges of type X."
- *Scored:* **deterministic SET RECALL** = fraction of gold members appearing in the
  answer (and, for storage, in the retrieved context). *No LLM judge* — fully
  reproducible and unspinnable. Reported as the average recall (e.g. 7.1/10).

**7. `aggregation`** *(7 q)* — counts and single-target filters.
- *Example:* "How many cities has Max lived in?" → **2**; "Which relative is a
  doctor?" → **Raj**.
- *Probes:* gathering + counting/filtering over a neighborhood. (Notably, rich
  retrieval can *overcount* here — surfacing distractor-polluted edges.)
- *Scored:* LLM answer-judge (binary on the count / named target).

### Suite C — Absence / anti-hallucination (23 questions)

**8. `absence`** *(16 q)* — baited negatives. The answer is **no**, and each is
**baited** with a tempting distractor that exists in the corpus about someone else.
- *Example:* "Does Max own a dog?" → **No** (his only pet is the cat Biryani — but a
  distractor mentions a cousin's beagle "Rufus"); "Does Max work at Stripe?" → **No**
  (that's his friend Lena's employer).
- *Probes:* hallucination resistance — to correctly say "no" you must know the
  *complete, bounded* set and not be lured into a false "yes."
- *Scored:* existence-aware LLM judge — correct only if the yes/no matches truth; a
  confident "yes" to a non-existent thing (a hallucination) is wrong; "I don't know"
  is treated as not-a-hallucination.

**9. `presence-control`** *(7 q)* — genuine "yes" questions ("Does Max have a
sister?" → **Yes, Anita**), included so a system that blindly answers "no" can't game
the absence suite. Measures decisiveness on facts that *do* exist.
- *Scored:* existence judge — correct only if it correctly affirms and names the
  right thing.

---

## 4. Results

### Suite A — 100 questions (answer / storage)

| System | Answer | Storage | flat (34) | relational (22) | multi-hop (22) | temporal (22) |
|---|---|---|---|---|---|---|
| naive | **79** | 78 | 28 | **22** | 15 | 14 |
| mem0 | 78 | **79** | 24 | 21 | **19** | 14 |
| ci_server | 75 | 78 | 26 | 19 | 12 | **18** |
| holographic | 69 | 72 | 25 | 20 | 13 | 11 |
| openviking | 47 | 56 | 18 | 6 | 15 | 8 |
| hindsight | 25 | 21 | 7 | 9 | 4 | 5 |

### Suite B — Structured (answer; enumeration = set-recall)

| System | Answer | Storage | temporal (20) | enumeration (10) | aggregation (7) |
|---|---|---|---|---|---|
| mem0 | 25.2 | 26.2 | 13.0 | 6.2 | **6.0** |
| naive | 24.9 | 24.2 | 14.0 | 4.9 | **6.0** |
| ci_server | 24.1 | **27.0** | **15.0** | **7.1** | 2.0 |
| openviking | 12.8 | 14.4 | 7.0 | 2.8 | 3.0 |
| hindsight | 9.9 | 10.2 | 5.0 | 2.9 | 2.0 |
| holographic | 9.5 | 11.5 | 7.0 | 0.5 | 2.0 |

### Suite C — Absence (answer / absence / control)

| System | Answer | absence (16) | presence-control (7) |
|---|---|---|---|
| naive | 20 | 15 | 5 |
| mem0 | 18 | 14 | 4 |
| ci_server | 18 | 11 | **7** |
| hindsight | 18 | 14 | 4 |
| holographic | 20 | 14 | **6** |
| openviking | 15 | 12 | 3 |

### Cost (memory-layer work; answer phase is the shared model, excluded)

| System | Ingest (490 msgs) | Recall latency / query | Concurrency-safe |
|---|---|---|---|
| naive | 16 s | ~60 ms | ✅ |
| mem0 | ~15 min | ~120 ms | ✅ |
| ci_server | ~16 min | ~80 ms | ✅ |
| hindsight | ~35 min¹ | ~1160 ms | ❌ (recall 500s under load) |
| openviking | **~50 min** | ~30 ms | ✅ |
| holographic | **5 s** | **~5 ms** | ✅ |

¹ with a concurrency boost only Hindsight received; sequential it is ~2.3 h.

**Holographic query caveat (important for fairness):** Holographic is keyword-only
(SQLite FTS5 + HRR), with no semantic embedder. FTS5 ANDs query terms, so a raw
natural-language question matches nothing. Like our naive baseline and ci_server's
boosted search (which OR their keyword terms), the adapter sends Holographic an
**OR-of-keywords** query (stopwords dropped). Without this it scores ~0 — an artifact
of the query format, not the system. In real Hermes use its agent's LLM would issue
the keyword query; here it gets a mechanical OR-of-terms, identical treatment to the
other keyword paths.

---

## 5. Honest conclusions

- **Flat fact lookup is a solved problem** — naive vector RAG ties or wins it at a
  fraction of the cost. A graph is overkill there.
- **CI-Server's edge is structured/temporal/relational memory** — best temporal,
  best enumeration, best retrieval completeness, most decisive on present facts, all
  at ~80 ms recall and concurrency-safe.
- **Trade-offs:** aggregation (counting) and absence-precision are
  weak spots (the flip side of surfacing rich context); multi-hop trails mem0's
  consolidation; ingest is mid-pack.
- **OpenViking & Hindsight** — the two other graph/context-DB systems — both land
  *below* CI-Server on the structured tasks; OpenViking is fast at recall but
  slowest to ingest and weak on relational/temporal/enumeration.
- **Holographic is the efficiency dark horse** — a no-LLM, no-embedding local
  SQLite+FTS5+HRR store: **fastest ingest (5 s) and fastest recall (~5 ms)**, and a
  surprisingly strong **69/100** on broad flat/relational recall (4th overall). But
  it **collapses on structured tasks** — enumeration **0.5/10** (FTS5 can't assemble
  a set), weak temporal — so it doesn't challenge CI-Server where structure matters.
  Reinforces the theme: cheap keyword methods are strong on one-shot recall, weak on
  relational/temporal reasoning.

## 6. Reproduce

`scripts/benchmark/v2/`: `orchestrator.py` (harness) · `docker-compose.yml`
(one container per system) · personas in `../personas/` · per-suite reports
`report_v2_100q.md`, `report_v2_struct.md`, `report_abs_*.md` · charts in `charts/`
(`make_charts.py`).
