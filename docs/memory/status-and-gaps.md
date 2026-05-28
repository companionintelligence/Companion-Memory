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

| Plan item                                                                  | On `main` after agent-memory merge + this PR                                       | Status |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| **REST endpoint** at `agents.ci-domain/v1/memory/context` (paused-agent ingest) | `POST /api/memory/turn` is the live agent-ingest path (in `AgentModule`). Currently a no-op stub — calling it is safe and forward-compatible. Path is `/api/memory/*`, not the plan's literal `/v1/memory/context`. | 🟡 (stub) |
| `context_log` table for raw paused-agent context                           | Reserved at `POST /api/memory/turn`; persistence to be implemented inline (the controller comment outlines the planned `threadService` + `messageService` flow). | ❌      |
| **Hermes plugin** with `is_available`, `initialize`, `sync_turn`           | `plugins/hermes-companion-memory/` — implements `is_available`, `initialize`, `system_prompt_block`, `prefetch`, `sync_turn`, `on_session_end`, `on_memory_write` (logged no-op), `shutdown`, and three explicit tools. | ✅      |
| **OpenClaw plugin** stub                                                   | `plugins/openclaw-companion-memory/` — SKILL.md + manifest + installer that wires the MCP server into OpenClaw's `mcp_servers.json` | ✅      |
| **Ermy post-install script** — mint per-device API key, write `~/.hermes/.env` + `config.yaml`, `pip install hermes-companion-memory`, enable provider | `scripts/install-companion-memory.sh` + `scripts/companion-memory/mint-api-key.sh` — manual, requires a JWT and explicit user steps. No Ermy hook. | 🟡     |
| `agents.ci-domain` DNS + TLS (Caddy/Cloudflare) — Steve / Bennett, Day 2   | Endpoints live on the existing CI-Server (`memory.ci.localhost` / port 3030)        | ❌      |
| Private repos: `hermes-companion-memory`, `openclaw-companion-memory`      | Both live in this monorepo under `plugins/`. License + repo split not decided.     | ❌      |
| FastAPI skeleton behind existing auth middleware (Day 2)                   | NestJS controllers behind `ApiKeyGuard` (`/api/memory/*`) and `JwtOrApiKeyAuthGuard` (`/api/graph/*`) | 🟡 |
| Internal eval set (`eval/personal_context_v1.jsonl`, Lex / Day 5)          | Described in `benchmarking.md` as **CI-DOSSIER** but no `.jsonl` file generated yet | ❌      |
| 50-prompt baseline (Liam / Max / Steve scenarios)                          | Not started                                                                        | ❌      |
| Success metric: **p99 round-trip < 200ms** on Ermy installs                | Untested — no live Ermy install yet                                                | ❌      |
| Success metric: 100% of Ermy installs route a full session                 | Not measurable until Ermy + Hub ship                                               | ❌      |

### Endpoint shape on main

After `feature/agent-memory` landed (PR [#1421](https://github.com/companionintelligence/CI-Server/pull/1421))
and the follow-on "Align on memory API" / "Remove tool calling from agent
domain; rely on MCP" commits, the surface settled here:

| Surface                              | Purpose                                                       | Caller                                              |
| ------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------- |
| `POST /api/memory/recall`            | Semantic recall returning a Markdown block (`{block, resultCount}`). | Hermes `prefetch`, OpenClaw `assemble`.    |
| `POST /api/memory/turn`              | Conversation ingest. Currently a no-op; reserved for thread + message persistence. | Hermes `sync_turn`, OpenClaw `afterTurn`. |
| `POST /api/memory/persist` (reserved)| Declared as a commented no-op in the controller, intended for explicit-store flows. | Hermes `on_memory_write`, OpenClaw `memory_store`. |
| `GET /api/graph/context`             | User dossier as JSON.                                         | Hermes `system_prompt_block`, MCP `companion_context`. |
| `GET /api/graph/search`              | Hybrid search returning structured nodes + links.             | MCP `companion_search`.                              |
| `GET /api/graph/node`                | Single entity with bounded neighbour traversal.               | MCP `companion_node`.                                |

The team's explicit design decision was **small backend surface, rich MCP
tool layer** (commit `c4acbdd1` literally: "Remove tool calling from agent
domain; rely on MCP"). The MCP server provides the rich tool layer; the
Hermes plugin maps hooks 1:1 onto the backend endpoints. There is **no
fallback path** — earlier drafts of this PR carried richer CRUD endpoints
under `/api/memory/{remember,list,forget,context,health}` and a parallel
`/api/agent/{context,absorb,tools}` surface, but those were retired in
favour of main's smaller design.

---

## 2. MVP v2 — Functional Retrieval

| Plan item                                                                   | On `main` + this PR                                                              | Status |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| `prefetch(query)` returns a ready-to-inject Markdown block                  | `POST /api/memory/recall` returns `{block, resultCount}`. Hermes plugin's `prefetch` calls it directly. | ✅ |
| Embed incoming context → semantic search on entity index                    | `RecallService.recall` runs `SearchService.search` with `mode: 'keyword'` (TODO comment in code: hydrate entity names from the graph for richer snippets). | 🟡 |
| Persist incoming context as memories with edges to referenced entities      | `/api/memory/turn` is a no-op stub. The controller comment outlines the intended `threadService.upsert` + `messageService.create` flow. | ❌ |
| **K-hop graph traversal** (K=1, K=2 above threshold) with relationship typing | Existing `readKnowledge` native tool does this; MCP's `companion_node` exposes a bounded variant via `/api/graph/node`. Inline K-hop expansion in recall is not done. | 🟡 |
| **Relevance threshold** (default cosine 0.65) to suppress token vomit       | Not implemented; recall returns top-N unconditionally.                          | ❌      |
| **Hardware-tier auto-config** (Workstation / Hobbyist / Single-24GB / Mid / Min / Cloud) | Not implemented; nothing inspects local GPUs.                          | ❌      |
| Small memory-side model on secondary GPU (Qwen3-4B class)                   | Not implemented.                                                                 | ❌      |
| Token budget cap (≤ 1,200 tokens per injection)                             | The plan's ≤ 1,200 token cap isn't enforced in `RecallService` yet (an earlier draft of this PR had a 3,000-char cap that the merge stripped — needs reintroduction). | ❌ |
| `companion_search` + `companion_remember` explicit tools                    | MCP server exposes `companion_search` (via `/api/graph/search`). An explicit `companion_remember` is not viable until `/api/memory/persist` lands. | 🟡 |
| Migrate deprecated in-app chat → memories                                   | Not addressed.                                                                   | ❌      |
| 30-type default relationship-type ontology                                  | The existing graph already has **48** relationship types; recall doesn't filter by them yet. | 🟡 |
| Success: precision ≥ 70% on internal eval                                   | No eval run yet                                                                  | ❌      |
| Success: p95 prefetch < 250ms                                               | Unmeasured                                                                       | ❌      |
| Success: zero token-vomit injections                                        | Unmeasured (no cap enforced)                                                     | ❌      |
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

1. **Implement the `POST /api/memory/turn` body.** The controller comment
   already outlines it: `threadService.upsert(sessionId)` +
   `messageService.create(userMessage)` +
   `messageService.create(assistantMessage)`. Once this lands, Hermes'
   `sync_turn` starts persisting for free (the plugin already calls the
   endpoint). **Owner**: backend. **Effort**: 1–2 days.
2. **Add the `POST /api/memory/persist` route** for explicit
   `on_memory_write` flows. Today it's commented out in the controller.
   Once live, the Hermes plugin's `on_memory_write` switches from
   logged-no-op to write. **Owner**: backend. **Effort**: ~half day.
3. **Hydrate richer recall snippets.** `RecallService.recall` has a TODO
   to format `name + description` rather than `type · id`. Lifts
   prefetch quality directly. **Owner**: backend. **Effort**: ~2 hours.
4. **Re-introduce a token-budget cap in `RecallService.recall`.** Either
   character cap (~3,000) or token-count cap (~1,200 per the plan).
   **Owner**: backend. **Effort**: ~1 hour.
5. **Generate the 50-prompt internal eval set** at
   `eval/personal_context_v1.jsonl`. Three users × ~17 prompts each.
   **Owner**: Lex / agent. **Effort**: ~1 day, longer if ground truth is
   hand-validated.
6. **Stand up `agents.ci-domain`** (DNS + TLS). Could point at the same
   NestJS backend for now. **Owner**: Steve / Bennett. **Effort**: ~half
   day.
7. **Decide license** before any repo split. Plan recommends MIT for
   both plugins. **Owner**: Liam + Max. **Effort**: 30-minute call.

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
