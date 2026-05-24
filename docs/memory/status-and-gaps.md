# Status & Gaps — This PR vs the Memory Plan

> Companion to [`ci-memory-plan.md`](./ci-memory-plan.md). Maps what this PR
> (#1418) actually ships against the v1 / v2 / v3 stages of the plan, and
> spells out exactly what remains before each stage is "done".

Legend:
- ✅ **shipped** — the PR contains a working implementation of this item.
- 🟡 **partial / different shape** — the PR contains something *adjacent* but
  not the literal artefact described in the plan.
- ❌ **missing** — not in this PR; still needs to be built or decided.

---

## 0. Stage gating — the precondition

The plan names Companion Hub installation as **the bottleneck**: the v1
steel thread becomes active only "when Hub clears trigger". The plan also
calls out a parallel unblocking workstream — subdomain, eval set, plugin
scaffolds, post-install script — that can move before Hub ships.

| Item                                                              | Status |
| ----------------------------------------------------------------- | ------ |
| Hub install instrumentation                                       | ❌      |
| Hub install milestone / threshold telemetry                       | ❌      |
| Visible signal to the team that plugin work waits on Hub          | ❌      |

This PR is positioned as **unblocking, dormant-asset work** — exactly
what the plan's Stage 1—2 anticipates. The scaffolds are ready; nothing
here ships to users until Hub clears its trigger.

---

## 1. MVP v1 — Steel Thread

The plan's v1 is a deliberately tiny round-trip: paused agent → `POST
/v1/memory/context` → log → 204. This PR aimed broader (full CRUD), so
the mapping is partial.

| Plan item                                                                  | This PR                                                                            | Status |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| **REST endpoint** at `agents.ci-domain/v1/memory/context` (paused-agent ingest, returns ack) | Two endpoints now live: `POST /api/agent/absorb` (paused-agent ingest, `{ok}` response) and `POST /api/memory/remember` (deliberate CRUD). Domain path differs from the plan's literal URL, but the role is filled by `AgentModule` (cherry-picked from `feature/agent-memory`). | ✅      |
| `context_log` table for raw paused-agent context                           | `AbsorbService` upserts into the existing `Communication` entity keyed by `sessionId` (one row per session, grows as conversation grows). No new table needed; the existing graph model carries it cleanly. | ✅      |
| **Hermes plugin** with `is_available`, `initialize`, `sync_turn` (no-op `prefetch` in v1) | `plugins/hermes-companion-memory/` — implements **all** of v1 *and* parts of v2/v3 (`prefetch`, `on_session_end`, `on_memory_write`, tool handlers). Now prefers `/api/agent/*` with fallback to `/api/memory/*`. | ✅ (++) |
| **OpenClaw plugin** stub (`memory_search`, `memory_get` return empty)      | `plugins/openclaw-companion-memory/` — SKILL.md + manifest + installer that wires the MCP server into OpenClaw's `mcp_servers.json` | ✅      |
| **Ermy post-install script** — mint per-device API key, write `~/.hermes/.env` + `config.yaml`, `pip install hermes-companion-memory`, enable provider | `scripts/install-companion-memory.sh` + `scripts/companion-memory/mint-api-key.sh` — manual, requires a JWT and explicit user steps. No Ermy hook. | 🟡     |
| `agents.ci-domain` DNS + TLS (Caddy/Cloudflare) — Steve / Bennett, Day 2   | Endpoints live on the existing CI-Server (`memory.ci.localhost` / port 3030)        | ❌      |
| Private repos: `hermes-companion-memory`, `openclaw-companion-memory`      | Both live in this monorepo under `plugins/`. License + repo split not decided.     | ❌      |
| FastAPI skeleton behind existing auth middleware (Day 2)                   | NestJS controller behind existing `JwtOrApiKeyAuthGuard` (memory) and `ApiKeyGuard` (agent) — same auth posture, different stack | 🟡 |
| Internal eval set (`eval/personal_context_v1.jsonl`, Lex / Day 5)          | Described in `benchmarking.md` as **CI-DOSSIER** but no `.jsonl` file generated yet | ❌      |
| 50-prompt baseline (Liam / Max / Steve scenarios)                          | Not started                                                                        | ❌      |
| Success metric: **p99 round-trip < 200ms** on Ermy installs                | Untested — no live Ermy install yet                                                | ❌      |
| Success metric: 100% of Ermy installs route a full session                 | Not measurable until Ermy + Hub ship                                               | ❌      |

### Reconciling the endpoint-shape difference — resolved

The original gap analysis flagged that the plan's `POST /v1/memory/context`
ingest path and this PR's `/api/memory/remember` CRUD path needed to
coexist. That's done — by pulling `AgentModule` over from
`feature/agent-memory`:

| Surface                              | Purpose                                                       | Caller                                        |
| ------------------------------------ | ------------------------------------------------------------- | --------------------------------------------- |
| `POST /api/agent/absorb`             | Paused-agent ingest. Upserts a Communication row by `sessionId`. | Hermes `sync_turn`, OpenClaw `agent_end`.     |
| `GET /api/agent/context`             | L0 user dossier as a ready-to-inject Markdown block.          | Hermes `system_prompt_block`.                 |
| `POST /api/agent/recall`             | L1 semantic recall as Markdown, capped at ~3k chars.          | Hermes `prefetch`.                            |
| `POST /api/agent/tools`              | Dispatch `ci_search` / `ci_query` / `ci_remember`.            | Hermes tool calls.                            |
| `POST /api/memory/remember`          | Deliberate fact storage with name/tags/metadata.              | MCP `companion_remember`, manual UI, scripts. |
| `GET /api/memory/recall`             | Hybrid query, returns structured JSON.                        | MCP `companion_recall`.                       |

Why not just one surface? Because they answer different questions. The
`/agent/*` endpoints know they're talking to an agent loop and return
Markdown blocks pre-shaped for prompt injection (with the token cap
already applied). The `/memory/*` endpoints know they're talking to a
UI or a script and return structured JSON the caller will format
themselves.

The Hermes plugin **prefers `/api/agent/*`** for its three hooks and
**falls back to `/api/memory/*`** on 404, so it keeps working against
older CI-Servers. The MCP server exposes **both** toolsets so MCP hosts
get both shapes (`ci_*` + `agent_*` for prompt-injection-style flows,
`companion_*` for explicit CRUD).

---

## 2. MVP v2 — Functional Retrieval

| Plan item                                                                   | This PR                                                                          | Status |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| `prefetch(query)` returns a ready-to-inject Markdown block                  | `/api/agent/recall` returns `{ block, resultCount }`, used by the Hermes plugin's `prefetch`. Plan also wanted `entities_used` — not yet, see [next action 1](#51-unblocking-work-the-plan-wants-done-now-no-hub-dependency). | ✅ (mostly) |
| Embed incoming context → semantic search on entity index                    | `/api/agent/recall` runs `SearchService.search` with `mode: 'auto'` (hybrid keyword + embedding) on the existing entity index | ✅      |
| Persist incoming context as memories with edges to referenced entities      | `AbsorbService` persists as a `Communication` row. Edge creation to referenced entities (entity extraction from message text) is not yet automatic | 🟡     |
| **K-hop graph traversal** (K=1, K=2 above threshold) with relationship typing | `readKnowledge` native tool exposes this; `ci_query` (`/agent/tools`) surfaces it at the agent boundary. Inline K-hop expansion in `recall` itself is still TODO. | 🟡 |
| **Relevance threshold** (default cosine 0.65) to suppress token vomit       | Not implemented; recall returns top-N unconditionally.                          | ❌      |
| **Hardware-tier auto-config** (Workstation / Hobbyist / Single-24GB / Mid / Min / Cloud) | Not implemented; nothing inspects local GPUs.                          | ❌      |
| Small memory-side model on secondary GPU (Qwen3-4B class)                   | Not implemented.                                                                 | ❌      |
| Token budget cap (≤ 1,200 tokens per injection)                             | `MAX_BLOCK_CHARS = 3000` cap in `RecallService` (~750–900 tokens — below the plan's 1,200 ceiling) | ✅      |
| `companion_search` + `companion_remember` explicit tools                    | Shipped as both `companion_*` (CRUD shape) and `ci_search/ci_query/ci_remember` (agent shape) via the MCP server | ✅ (++) |
| Migrate deprecated in-app chat → memories                                   | Not addressed.                                                                   | ❌      |
| 30-type default relationship-type ontology                                  | The existing graph already has **48** relationship types; the recall surface doesn't expose them yet for filtering | 🟡 |
| Success: precision ≥ 70% on internal eval                                   | No eval run yet                                                                  | ❌      |
| Success: p95 prefetch < 250ms                                               | Unmeasured                                                                       | ❌      |
| Success: zero token-vomit injections                                        | Unmeasured                                                                       | ❌      |
| Success: 100 active CI memory-provider users                                | Gated on v1                                                                      | ❌      |

---

## 3. v3 — Differentiated / VC-Ready

Everything in v3 is **❌** in this PR — and that's the right state for now,
since the plan only starts v3 after v2 has shipped and accumulated 1,000
active users.

| Plan item                                                                 | Status |
| ------------------------------------------------------------------------- | ------ |
| Pre-warmed in-memory Postgres of Dunbar-120 contacts + top-1000 places    | ❌      |
| Two-shot inference (pre-LLM resolver → main LLM → post-LLM verifier)      | ❌      |
| Entity-ID tagging in prompts (`Steve Barry [p_182]`)                      | ❌      |
| Pronoun / assumption vectorization for co-reference                       | ❌      |
| **HBPE / Personal Forecast predictive injection** — the wedge             | ❌      |
| Hyperlinked output cards                                                  | ❌      |
| Parallel non-blocking vLLM execution                                      | ❌      |
| Sub-agent orchestration for personal-life query trees                     | ❌      |
| Nightly memory consolidation / "dream" jobs                               | ❌      |
| Cache pre-fill / warming on calendar-event open                           | ❌      |
| Success: precision ≥ 85%                                                  | ❌      |
| Success: p95 end-to-end ≤ main-LLM-alone + 150ms                          | ❌      |
| Success: zero hallucinated entities (verifier catches them)               | ❌      |
| Success: Forecast injection +20% subjective relevance in user study       | ❌      |

The honest framing: **this PR is foundation work for v1 with a forward
projection into v2 and v3** (the docs in `context-engineering.md` and
`benchmarking.md` are the projection). None of the v3 differentiators are
shipped yet.

---

## 4. Cross-cutting items

### 4.1 Open-source / repo split

| Plan item                                                | Status |
| -------------------------------------------------------- | ------ |
| MIT-license the Hermes plugin                            | ❌      |
| MIT-license the OpenClaw plugin                          | ❌      |
| Apache-2.0 the Companion Memory SDK (TS + Python)        | ❌ (no separate SDK package yet) |
| Keep CI-Server / HBPE / Forecast proprietary             | ✅ (unchanged) |
| Open-source CI-Server-lite (loss-leader)                 | ❌      |
| Move plugins out of the monorepo into private repos      | ❌      |

The plugins currently live in `plugins/` of this proprietary repo. The
plan calls for them to live in **separate public repos**
(`hermes-companion-memory`, `openclaw-companion-memory`) under MIT once
Hub ships. This is a follow-on.

### 4.2 Benchmarking / evaluation

| Plan item                                                | This PR                                | Status |
| -------------------------------------------------------- | -------------------------------------- | ------ |
| 50-prompt internal eval set                              | Described in `benchmarking.md`         | ❌      |
| LongMemEval harness adapter                              | Described in `benchmarking.md`         | ❌      |
| LoCoMo harness adapter                                   | Described in `benchmarking.md`         | ❌      |
| CI-DOSSIER synthetic personal corpus + 400 Q            | Designed in `benchmarking.md`          | ❌      |
| Per-provider adapters (8 alternatives + no-memory)       | Designed in `benchmarking.md`          | ❌      |
| Scoring rubric (security 10pt, tractability 10pt)        | Defined in `benchmarking.md`           | ✅ (spec) |
| Headline-table CSVs + aggregation notebook               | n/a                                    | ❌      |

The plan and the doc agree on what to measure; we still need to write the
harness and run the cells.

### 4.3 Ermy / Hub / agents.ci-domain

| Plan item                                                | Status |
| -------------------------------------------------------- | ------ |
| `agents.ci-domain` subdomain provisioned with TLS        | ❌      |
| FastAPI hello-world behind existing CI auth middleware    | 🟡 (NestJS controller serves the same role) |
| Ermy embeds per-device API key on install                | ❌      |
| API-key scoping is per-device, revocable, rate-limited   | 🟡 (per-user, revocable; not per-device, not rate-limited beyond global) |
| Hub installer milestone instrumentation                  | ❌      |

### 4.4 Community management

| Plan item                                                | Status |
| -------------------------------------------------------- | ------ |
| Discord channels (`#hermes-plugin`, `#openclaw-plugin`, `#sdk-help`, `#showcase`) | ❌ |
| Weekly office hours                                       | ❌      |
| Public roadmap (GitHub Projects)                          | ❌      |
| Part-time community manager (Bennett / Anselm split)      | ❌      |
| DevRel hire (12-month trigger)                            | ❌      |

---

## 5. Next concrete actions

In priority order, organized by who's blocked on whom:

### 5.1 Unblocking work the plan wants done *now* (no Hub dependency)

1. **Surface `entities_used` from `/api/agent/recall`.** The plan's v2
   payload includes the list of entity ids that contributed to the
   injection so callers can hyperlink them. `RecallService.recall`
   already has these (`searchResults.map(r => r.id)`) — just return them
   alongside `block`. **Owner**: backend. **Effort**: ~1 hour.
2. **Lift entity-edge extraction out of `AbsorbService`.** Today every
   absorb writes a single Communication row with the messages as opaque
   JSON. Add an async post-write step that resolves mentioned people /
   places against the graph and creates `MENTIONS_PERSON`,
   `MENTIONS_PLACE` edges. **Owner**: backend. **Effort**: 1–2 days.
3. **Generate the 50-prompt internal eval set** at
   `eval/personal_context_v1.jsonl`. Three users × ~17 prompts each.
   **Owner**: Lex / agent. **Effort**: ~1 day for the dataset, longer if
   ground truth is hand-validated.
4. **Stand up `agents.ci-domain`** (DNS + TLS). Could point at the same
   NestJS backend for now, no rewrite needed. **Owner**: Steve / Bennett.
   **Effort**: ~half day.
5. **Decide license** before any repo split. Recommendation in the plan:
   MIT for both plugins. **Owner**: Liam + Max. **Effort**: a 30-minute
   call.
6. **Wire MCP server smoke test to cover both surfaces.** Today the
   smoke script exercises `/memory/*` only; extend it to call
   `/agent/{context,recall,absorb}` end-to-end. **Owner**: plugin author.
   **Effort**: ~1 hour.

### 5.2 Hub-gated work (paused until 1,000 installs)

7. **Per-device API key minting in Ermy installer** (the bash script in
   the plan, §D.3). Should reuse `scripts/companion-memory/mint-api-key.sh`
   internally.
8. **Public repo split + license + initial release** of
   `hermes-companion-memory` and `openclaw-companion-memory`.
9. **MVP v2 features** in priority order: embedding-based recall path,
   structured injection payload, graph-edge extraction from incoming
   context, K-hop traversal, relevance threshold, hardware-tier
   auto-config, token budget cap.

### 5.3 v3 — start after 1,000 active users on v2

10. v3 build list as written in `ci-memory-plan.md` §C.

---

## 6. Reading order for new reviewers

If you're joining this PR cold:

1. **Read the plan first**: [`ci-memory-plan.md`](./ci-memory-plan.md).
2. **Read this status doc** to understand what's in the PR vs in the plan.
3. **Architecture** (what the PR ships): [`architecture.md`](./architecture.md).
4. **Per-surface integration guides**: [`mcp-integration.md`](./mcp-integration.md),
   [`hermes-integration.md`](./hermes-integration.md),
   [`openclaw-integration.md`](./openclaw-integration.md).
5. **Deep dive** (why this approach): [`context-engineering.md`](./context-engineering.md).
6. **How we'll prove it works**: [`benchmarking.md`](./benchmarking.md).
7. **Comparison**: [`providers-comparison.md`](./providers-comparison.md).
8. **Operational gotchas**: [`troubleshooting.md`](./troubleshooting.md).

— Status as of 2026-05-22 (PR #1418, branch
`companion/mystifying-newton-10c1c1`).
