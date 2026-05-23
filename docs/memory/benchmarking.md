# Benchmarking the Companion Memory System

> A concrete plan for proving (or falsifying) the claim that
> companion-memory is a more **accurate**, **secure**, **performant**, and
> **tractable** substrate for personal AI agents than the alternatives
> available in the Hermes ecosystem today.

## 1. What we want to measure

The four properties we want to show, in priority order:

1. **Accuracy** on personal-data Q&A tasks across single-hop, multi-hop,
   and temporal categories.
2. **Performance** end-to-end per-turn latency and token cost.
3. **Security & locality** — what data leaves the user's machine, under
   what conditions.
4. **Tractability** — operational burden, migration friction, and the
   number of moving pieces a user has to understand.

The first two are quantitative. The last two are partly qualitative; we'll
score them with a structured rubric so they remain comparable.

## 2. The provider matrix

We benchmark against the seven other Hermes-supported providers plus a
no-memory baseline:

| Provider              | Where data lives          | Notes                                          |
| --------------------- | ------------------------- | ---------------------------------------------- |
| **no-memory**         | n/a                       | Baseline — Hermes with `hermes memory off`.    |
| **honcho**            | Cloud (or self-host FastAPI) | Peer model + dialectic loop.                |
| **openviking**        | Self-hosted sidecar       | L0/L1/L2 tiered context.                       |
| **mem0**              | Cloud (managed)           | Auto-extraction, async writes default.         |
| **hindsight**         | Cloud or local            | Structured KG + reranking.                     |
| **holographic**       | Local SQLite              | HRR algebra, zero deps.                        |
| **retaindb**          | Cloud                     | Hybrid (vector + BM25 + rerank).               |
| **supermemory**       | Cloud                     | container_tag scoping.                         |
| **byterover**         | Local Markdown            | `.brv/context-tree/` filesystem.               |
| **companion-memory**  | Self-hosted (CI-Server)   | Graph + pgvector + FTS in one Postgres.        |

Cloud providers are run against their managed APIs with a free tier where
available; we'll publish per-provider config so others can reproduce.

## 3. Datasets

### 3.1 LongMemEval (500 questions, 5 abilities)

The standard academic benchmark.

| Ability                 | Tests                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| Information extraction  | "What's my dietary restriction?" — single-fact recall.               |
| Multi-session reasoning | "What did we decide about X in our talk last Tuesday?"               |
| Knowledge updates       | "I switched from Pilates to yoga last month — what should I book?"  |
| Temporal reasoning      | "What was I working on around the time of the Berlin trip?"          |
| Abstention              | "What's my favourite type of submarine?" → must refuse, not invent.  |

We run the standard scoring harness from the LongMemEval repo. No
adaptation is needed; the dataset is provider-agnostic.

### 3.2 LoCoMo (1,540 questions, 4 categories)

Larger sweep across single-hop, multi-hop, open-domain, and temporal
recall. Critical for showing graph-vs-vector trade-offs.

### 3.3 BEAM (scale test)

Optional. Runs the same agent against synthetic conversation histories at
1M, 10M tokens. The 2026 results showed the leading providers drop from
~64 to ~49 between 1M and 10M; this lets us measure how a graph-backed
store fares at scale.

### 3.4 Personal-data adaptation: "CI-DOSSIER"

The academic benchmarks are conversation-only. For a personal-data store,
the bigger story is data that arrived *outside* the chat — emails, calendar
events, location history, browsing.

We propose a new evaluation set, **CI-DOSSIER**:

- **Synthetic personal corpus**: Three fictional users with ~12 months of
  generated Gmail (~3k threads), Calendar (~800 events), Contacts (~250
  people), Spotify (~600 plays), Position (~6k samples), and Browser
  Activity (~25k entries). Generated with named-entity consistency so
  cross-source identity resolution is testable.
- **400 questions** across these categories:

  | Category | Example | Tests |
  | --- | --- | --- |
  | Single-fact retrieval | "What's Sarah's email?" | Identity resolution + property lookup. |
  | Multi-hop relational | "Who at Acme have I emailed in the last quarter?" | Graph traversal across PersonEntity + CommunicationEntity + EMAILED edges. |
  | Temporal | "What was I doing the Tuesday after my Berlin trip?" | Cross-source temporal join (Position + Calendar + Browser). |
  | Preference | "What's my most-listened-to artist this year?" | Spotify-derived PREFERS strength. |
  | Provenance | "Where did I learn that fact about photosynthesis?" | Source-attribution traversal. |
  | Contradiction | "What's my current zip code?" given two Position samples disagreeing. | Recency + freshness handling. |
  | Abstention | "What's my favourite type of trombone?" | Must refuse, not confabulate. |

- **Ground truth** is generated from the synthetic data and stored
  alongside, so evaluation is deterministic.

CI-DOSSIER tests what the academic benchmarks can't: a memory provider's
ability to operate over a multi-source personal-data graph. It's where
companion-memory's identity-resolution and graph-traversal capabilities
should pull ahead, and where vector-only providers should plateau.

## 4. Metrics

### 4.1 Accuracy (LongMemEval / LoCoMo / CI-DOSSIER)

- **Exact-match** on extraction questions.
- **LLM-as-judge** on reasoning / multi-session / temporal — using a
  separate scoring LLM (GPT-5 or Claude Opus 4.7) with a fixed rubric.
- **Abstention rate** on the abstention category: refuses-when-should ÷
  total abstention questions. A provider that confidently invents wrong
  answers should be penalised.
- **Per-category scores** reported separately, not just an aggregate.

### 4.2 Performance

Per question, captured by the benchmark harness:

- `t_retrieve` — time from "agent issues retrieval call" to "snippets
  returned".
- `t_total` — full turn latency.
- `tokens_in_prompt` — context size at model call time.
- `tokens_out` — model response.
- `total_$` — billable cost using OpenAI / Anthropic pricing.

We report median + p95 across the question set. (The 2026 production trend
is that p95 matters more than median for agent UX.)

### 4.3 Security & locality

A structured 10-point rubric scored per provider:

| # | Property                                                            | 1 pt |
| - | ------------------------------------------------------------------- | ---- |
| 1 | Data lives on user's hardware (homeserver or laptop), default.     |   ✓  |
| 2 | All wire traffic to the memory backend is over loopback or LAN.    |   ✓  |
| 3 | API auth is per-user, revocable, with audit log.                   |   ✓  |
| 4 | At-rest storage is reviewable by SQL or filesystem (no opaque blobs). |   ✓  |
| 5 | Memories can be exported in a portable format (JSON, MD, SQL dump). |   ✓  |
| 6 | Memories can be deleted permanently with proof (e.g. row gone).    |   ✓  |
| 7 | Prompt-injection scanning runs before content is stored.           |   ✓  |
| 8 | No outbound calls to third parties during normal operation.        |   ✓  |
| 9 | Supports per-source / per-namespace scoping (multi-agent isolation). |   ✓  |
| 10 | Memory writes carry provenance (source agent, time, hash).         |   ✓  |

Self-hosted local providers (holographic, byterover, companion-memory)
should score 9–10. Cloud providers will typically score 3–5.

### 4.4 Tractability

A separate 10-point rubric:

| # | Property                                                            | 1 pt |
| - | ------------------------------------------------------------------- | ---- |
| 1 | One-shot installer exists and works on macOS + Linux.              |   ✓  |
| 2 | Setup completes in under 5 minutes given API key / running deps.   |   ✓  |
| 3 | Configuration is documented in one page.                            |   ✓  |
| 4 | Logs are reachable and have actionable error messages.              |   ✓  |
| 5 | Memories are visible in a UI (no chat-only access).                 |   ✓  |
| 6 | Memories are queryable outside the agent (REST / SQL / file).       |   ✓  |
| 7 | Migrating *in* from another provider is documented.                 |   ✓  |
| 8 | Migrating *out* is documented and tested.                           |   ✓  |
| 9 | Works simultaneously with multiple agents without per-agent state.  |   ✓  |
| 10 | Schema upgrades have a migration story (not a wipe).               |   ✓  |

## 5. The harness

```
harness/
├── benchmarks/
│   ├── longmemeval/           # vendored dataset + runner
│   ├── locomo/                # vendored dataset + runner
│   └── ci-dossier/            # synthetic corpus generator + Q&A pairs
├── providers/
│   ├── _base.py               # ProviderAdapter interface
│   ├── honcho.py
│   ├── mem0.py
│   ├── ...
│   └── companion_memory.py    # uses the companion-memory MCP server
├── scoring/
│   ├── exact_match.py
│   ├── llm_judge.py
│   └── rubric.py              # security + tractability scoring
└── run.py                     # CLI: orchestrates one (dataset, provider) cell
```

`ProviderAdapter` is a thin shim that wraps each provider's "remember /
recall" API. Companion-memory's adapter reuses the existing TypeScript
client; others use their official SDKs.

For each `(dataset, provider)` cell we run:

1. **Ingest** — load the conversation/personal-data corpus through the
   provider's `remember` interface. Measure t_ingest_total and
   t_ingest_per_item.
2. **Query** — issue each question, capturing model response + retrieval
   timings + token counts. Re-run with three independent random seeds and
   average.
3. **Score** — apply category-appropriate scorer.
4. **Report** — emit a CSV per cell.

A final notebook aggregates the cells into the headline table and
per-category breakdowns.

## 6. What we expect to see (hypotheses)

Stated up-front so we don't post-hoc rationalize. These are predictions,
not findings.

**H1 — Multi-hop and provenance wins.** Companion-memory should
outperform vector-only providers (mem0, supermemory, retaindb) on the
LoCoMo multi-hop category by **5–15 points**, because graph traversal is
the native shape of the question.

**H2 — Temporal parity, not a win.** Companion-memory should be
competitive but not crushing on temporal questions, since none of the
existing providers solve temporal abstraction. Expected gap: **±3 points**.
This is a flag for future work.

**H3 — Latency competitive with local, faster than cloud.** Median
`t_retrieve` should be under **150ms** (same Postgres process the API uses
already). Cloud providers will typically be **250–500ms** depending on
region. Holographic (local SQLite) may beat us on simple key lookups but
not on multi-signal retrieval.

**H4 — Token cost parity.** Per-turn token cost should be within **±10%**
of mem0's reported ~6,900 tokens/query benchmark. We don't have a
mechanical advantage here — the savings story is on infra cost, not LLM
token cost.

**H5 — Security and tractability sweep.** Companion-memory should score
9–10 on both rubrics. Cloud providers should score 3–5 on security and
5–7 on tractability. Local providers (holographic, byterover) should be
competitive on security but lose on tractability (no UI, no cross-agent
sharing).

**H6 — CI-DOSSIER dominance.** On the personal-data benchmark we
designed, companion-memory should win by **15+ points** because
cross-source identity resolution and source-provenance traversal are
already in the ETL design and absent from generic memory providers.

If H6 is false — i.e. companion-memory does *not* substantially win on
CI-DOSSIER — that is a meaningful negative result and we should
re-examine whether the ETL→graph pipeline is doing what we think it is.

## 7. What "tractable" really means

It's worth spelling out, because it's the most subjective property:

A memory system is **tractable** for a personal-agent ecosystem if a
single user can:

- Understand where their data is stored, in one sentence.
- Look at the data in a UI.
- Run a query against it directly (SQL or REST) without going through an
  agent.
- Export it without vendor cooperation.
- Have multiple agents read and write the same store without per-agent
  configuration sprawl.
- Recover from a corrupted state without a vendor support ticket.

Cloud providers fail criteria 3–6 by construction. Local-only providers
(holographic, byterover) fail criterion 5 (no UI) and criterion 6
(multi-agent sharing requires file-locking gymnastics). Companion-memory
clears all six because the substrate is the same Postgres CI-Server has
always used — the user can `psql` it, the web UI already exists, every
agent reads through the same REST endpoint.

Tractability is what compounds across years of use. The provider you
pick today is the one whose schema you'll be live-migrating in 2030.

## 8. Schedule

| Phase                                         | Effort     |
| --------------------------------------------- | ---------- |
| Harness scaffold (`providers/_base.py`, `run.py`, exact-match + LLM-judge scorers) | 1 week |
| Companion-memory + 3 cloud-provider adapters  | 1 week     |
| LongMemEval runs (all 9 providers)            | 1 week     |
| LoCoMo runs                                   | 1 week     |
| CI-DOSSIER corpus generation + Q&A pairs      | 2 weeks    |
| CI-DOSSIER runs                               | 1 week     |
| Security + tractability rubric scoring        | 3 days     |
| Write-up + per-category notebook              | 1 week     |
| **Total**                                     | **~9 weeks** |

This is rough. The biggest swing is whether CI-DOSSIER corpus generation
gets a budget of named LLM calls — generating 25k browser-activity entries
that are internally consistent takes thought.

## 9. Reproducibility

- All benchmark code lives in `benchmarks/companion-memory/` of this repo
  (to-do — not yet scaffolded).
- All datasets are pinned by commit hash.
- All provider versions are pinned by package version.
- All LLM calls are logged with model id + temperature + seed where
  supported.
- The CSV outputs and the aggregation notebook are committed alongside.

The headline numbers we publish should be reproducible by anyone with the
same backend running and the same API keys. If they aren't, the
benchmark is wrong.

## 10. Open questions for reviewers

- Should the LLM-as-judge run on the same model as the agent we're
  testing, or a different one? Using the same model risks self-judging
  bias; using a different model risks cross-family disagreement that
  scores noise.
- How do we surface the cost of cloud providers honestly? A free-tier
  honcho run is not the same shape as a paid retaindb run. We should
  probably normalise on per-query $ at the published tier-1 pricing.
- Should we include a "bring your own retrieval" baseline — vanilla
  pgvector with no graph, no FTS, no identity resolution — to isolate
  how much of companion-memory's lift comes from the ETL pipeline vs the
  retrieval stack?
- Are there benchmark categories we *should* lose on, intentionally?
  (E.g. raw key-value latency, where holographic's HRR algebra over
  in-memory SQLite will be unbeatable.) Owning the loss makes the wins
  more credible.
