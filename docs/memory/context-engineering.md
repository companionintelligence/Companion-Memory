# Context Engineering for Personal AI Agents

> A deep-dive into the memory architectures of Hermes Agent and OpenClaw,
> how CI-Server already functions as a personal database, and why the
> companion-memory adapters give us a uniquely tractable substrate for the
> kind of context-engineering that 2026 benchmarks are measuring.

## 1. The problem: agents that *know you*

The 2026 state-of-memory data is consistent across LoCoMo, LongMemEval, and
BEAM. Commercial chat assistants and long-context LLMs drop **~30%** in
accuracy on information that's been said across prior sessions. Most of the
remaining failures that look like hallucinations turn out to be **retrieval
failures**, not generation failures.

Solving this for a *personal* agent (one that acts on behalf of a single
human across years of conversations, emails, calendar events, locations,
browsing history, and media consumption) is a different problem from solving
it for a generic chatbot:

- The data is **already there** — it lives in inboxes, calendars, files, and
  device sensors. The agent doesn't need to "learn" it from chat, it needs
  to **read it from the user's homeserver**.
- The data is **highly relational** — people, places, events, messages,
  preferences. Single-hop retrieval misses the answers; multi-hop graph
  traversal usually does not.
- The data is **temporal** — every fact has a `created_at`, every event has a
  `start_time`. Temporal reasoning is the hardest unsolved category in the
  2026 benchmarks, and it's first-class in any personal-data store.
- The data is **sensitive** — sending it to a cloud memory provider is a
  privacy regression compared with keeping it on the user's hardware.

This document explains how the existing CI-Server already solves most of
these problems as a byproduct of its ETL design, and how the three
companion-memory adapters expose that capability to the agent ecosystems
that exist today.

## 2. The memory landscape

### 2.1 Hermes Agent — frozen file + provider plugin

Hermes' built-in memory is intentionally small and deterministic:

| Layer        | File         | Size  | Lifecycle                                              |
| ------------ | ------------ | ----- | ------------------------------------------------------ |
| User profile | `USER.md`    | ~500 tokens | Loaded once into the system prompt at session start. |
| Agent notes  | `MEMORY.md`  | ~800 tokens | Loaded once into the system prompt at session start. |

Both files are injected as a **frozen prompt block** — changes written
during a session land on disk immediately but don't affect the prompt until
the *next* session. This is deliberate; the frozen snapshot preserves the
LLM's prefix cache (the first ~1300 tokens of the system prompt are
cacheable, which dramatically reduces marginal token cost per turn).

The `memory` tool supports three actions — `add`, `replace`, `remove` —
each using substring matching with automatic dedup and security scanning
for prompt-injection patterns. There is no `read` action; the file is
already in context.

For anything bigger than ~1300 tokens, Hermes delegates to one of eight
plugin-provided memory providers (honcho, mem0, openviking, hindsight,
holographic, retaindb, byterover, supermemory — see
[providers-comparison.md](./providers-comparison.md)). Only **one** memory
provider can be active per Hermes process; that provider is the one the
`MemoryProvider` ABC contract calls into during `prefetch`, `sync_turn`,
`on_session_end`, `on_memory_write`, and `system_prompt_block`.

Hermes' tools fall into two layers when companion-memory is active:

```
┌─────────────────────────────────────────────────────────────────┐
│ Frozen snapshot (~1300 tokens, prefix-cached)                   │
│ • USER.md profile + MEMORY.md notes                             │
│ • companion-memory system_prompt_block (current-user dossier)   │
├─────────────────────────────────────────────────────────────────┤
│ Per-turn prefetch (~variable, recomputed each turn)             │
│ • companion-memory prefetch → top-5 recall snippets for query   │
├─────────────────────────────────────────────────────────────────┤
│ On-demand (tool calls — only when the model decides to call)    │
│ • companion_recall, companion_remember, companion_list, etc.    │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 OpenClaw — layered filesystem + skills

OpenClaw treats memory as plain Markdown in the workspace, plus a more
ambitious **memory-wiki** plugin that introduces structured claims.

**Project context layer** (loaded each session, configurable caps):

| File           | Purpose                                                   |
| -------------- | --------------------------------------------------------- |
| `AGENTS.md`    | Agent identity and behavioural rules.                     |
| `SOUL.md`      | Long-term character / values block.                       |
| `TOOLS.md`     | Locally-described tools.                                  |
| `IDENTITY.md`  | "Who the agent is" — model, version, runtime.             |
| `USER.md`      | User profile.                                             |
| `HEARTBEAT.md` | Time-sensitive notes refreshed each turn.                 |
| `BOOTSTRAP.md` | First-run only.                                           |

Caps: `bootstrapMaxChars=12,000` per file, `bootstrapTotalMaxChars=60,000`
across all files. Files larger than the per-file cap are truncated with an
optional in-prompt warning.

**Skills**: each skill is a directory with a `SKILL.md` whose YAML
frontmatter declares activation rules. Important fields:

- `name`, `description` — required.
- `user-invocable` (default `true`) — exposes the skill as a slash command.
- `disable-model-invocation` (default `false`) — hides the skill from the
  normal prompt but allows explicit invocation.
- `command-dispatch: tool` + `command-tool: <name>` — bypass the model and
  dispatch the slash command directly to a tool.
- `metadata.openclaw.requires` — load-time gating: binaries, env vars,
  config keys, OS. Skills not meeting their gates are excluded from the
  prompt entirely, which keeps the skill list short and the token overhead
  predictable (~24 tokens per skill).

**Dreaming** (opt-in, runs at 3 AM by default) promotes short-term notes
into `MEMORY.md` via a three-phase scoring pass:

1. **Light** — ingest recent recall traces, dedup candidates.
2. **REM** — extract thematic patterns, add reinforcement boosts.
3. **Deep** — apply six weighted signals and gate promotion:
   - Frequency (0.24), Relevance (0.30), Query diversity (0.15),
     Recency (0.15), Consolidation (0.10), Conceptual richness (0.06).
   - Gates: `minScore`, `minRecallCount`, `minUniqueQueries`.

**Memory-wiki** is the more sophisticated tier — structured claims with
provenance (source, timestamp, confidence, freshness), contradiction
clustering, staleness detection, and a `wiki_lint` tool for integrity
checks. This is much closer to what CI-Server's knowledge graph already
provides.

### 2.3 Where the seams are

Both Hermes and OpenClaw assume their memory backend is **simple key/value
or markdown**. Both have grown more sophisticated layers (memory-wiki,
honcho's peer model, mem0's auto-extraction) to compensate. Both are
**single-process**, so memory written in one process isn't naturally
available to another.

CI-Server is exactly the substrate they're growing into: a multi-process,
multi-source personal database with native graph + vector + full-text
retrieval, all scoped by user.

## 3. CI-Server as a personal database (the substrate)

The CI-Server is not "a memory provider". It is a **personal data appliance**
that already ingests, normalizes, indexes, and serves personal data through
a knowledge graph. The companion-memory adapters expose a small fraction of
that capability to other agents through the conventions those agents
understand.

### 3.1 Data sources already ingested

The ETL pipeline (`backend/apps/api/src/domains/etl/`) syncs from four
provider families and 17+ endpoints:

| Provider  | Sync targets                                                                 |
| --------- | ---------------------------------------------------------------------------- |
| Google    | Gmail, Calendar, Contacts, Drive, YouTube (activities/subscriptions/playlists/likes) |
| Microsoft | Outlook Mail, Outlook Calendar, OneDrive                                     |
| Facebook  | Profile, Friends, Posts, Likes, Photos, Videos                               |
| Spotify   | Playlists, Saved Tracks, Recently Played, Top Artists, Saved Shows/Episodes/Audiobooks |

Plus first-party device data:

- **Browser activity** (`browser-activity/`) — every visit/reload/bookmark/search,
  with `duration_seconds`, `scroll_depth_percent`, `productivity_score`,
  `is_incognito`, `contains_sensitive`.
- **Position** (`position/`) — GPS / WiFi / cell-tower / inferred positions
  with reverse-geocoded address, heading, speed.
- **Conversations** (`conversations/`) — threads with the user's own LLM
  assistant.
- **Files** (`files/`) — uploaded artefacts referenced by entities.

### 3.2 Normalization to a graph

The pipeline is two-stage by design:

```
External API → SyncJob (raw JSON blob)
                  │
                  ▼
         Transform service (per provider)
                  │
                  ▼
         PromoteService (upsert)
            ┌─────┴─────┐
            ▼           ▼
        Person         Relationship
        Concept        (EMAILED, MET_WITH, ORGANIZED_EVENT_WITH, ...)
        Event
        Place
        Communication
        Content
        Item
        File
        ...
```

The graph models **12 entity types** and **48 relationship types**, covering
the full personal-data domain: social (KNOWS, WORKS_WITH), family (SPOUSE,
PARENT_OF), preference (PREFERS, DISLIKES), activity (PARTICIPATED_IN,
CREATED, VISITED, OWNED), communication (SENT, RECEIVED, EMAILED), location
(LIVES_IN, LOCATED_AT, HAPPENED_AT), and more.

PersonEntity is upserted **by email across sources**, which means
cross-source identity resolution — one of the unsolved 2026 problems —
is solved as a side-effect of the ETL design. The same email landing in a
Gmail thread, a Calendar invite, and a Facebook friends list resolves to a
single `PersonEntity` with three relationship edges back to the user.

### 3.3 Retrieval substrate

The Postgres stack carries three retrieval paradigms in a single database:

| Paradigm           | Postgres feature           | Used for                                    |
| ------------------ | -------------------------- | ------------------------------------------- |
| **Graph**          | Apache AGE                 | Multi-hop relationship traversal.           |
| **Embeddings**     | pgvector                   | Semantic similarity.                        |
| **Full-text**      | tsvector + GIN             | Keyword / prefix / exact matches.           |
| **Temporal**       | TimescaleDB hypertables    | Hot windows of measurements + activity.     |
| **Geo**            | PostGIS                    | Spatial joins on position + place entities. |

`SearchService` in `search-next/` exposes five retrieval modes — `semantic`,
`keyword`, `boosted`, `hybrid`, `auto` — with explicit weights:
- ts_rank A=1.0 (names), B=0.4 (descriptions), C=0.2 (categories), D=0.1 (properties).
- Embedding boost multiplier 0.5 on keyword score.
- Auto mode heuristically routes short queries to keyword, long natural
  language to semantic, and the middle to boosted-keyword.

This is exactly the **multi-signal hybrid retrieval** that the 2026
benchmarks identify as the production-winning architecture, without any
external services.

### 3.4 Native tools as a context-engineering API

The `tools/providers/native/` layer is the most overlooked piece. It is the
context-engineering API for LLMs talking to the personal database:

| Tool                            | What it does                                                       |
| ------------------------------- | ------------------------------------------------------------------ |
| `readKnowledge`                 | General graph query — semantic name resolution + multi-hop traversal. |
| `writeKnowledge`                | Create/update entities and relationships.                          |
| `forgetKnowledge`               | Archive or delete entities.                                        |
| `databaseSearch`                | Full-text + semantic search across all indexed entities.           |
| `getUserPreferences`            | Specialized: PREFERS/DISLIKES traversal.                           |
| `getFamilyMembers`              | Specialized: SPOUSE/PARENT_OF/CHILD_OF/SIBLING_OF.                 |
| `getEntertainmentPreferences`   | Specialized: Spotify-derived media taste.                          |
| `getStreamingAvailability`      | Specialized: which streaming services the user has.                |

The specialized tools matter. They illustrate the **context-engineering
principle**: rather than giving the LLM a giant general retrieval API and
hoping it constructs the right query, you ship a small bouquet of *intent-shaped*
tools whose schemas tell the LLM what's worth asking for. `getFamilyMembers`
is functionally a `readKnowledge` call with `relationshipTypes=['SPOUSE', 'PARENT_OF', 'CHILD_OF', 'SIBLING_OF']` — but as a top-level tool it shows up in
the LLM's tool list and gets reached for unprompted.

`readKnowledge` itself does semantic name resolution: "my wife" resolves
through SPOUSE traversal from the current-user entity, not through fuzzy
string matching. This is a small but meaningful piece of context engineering
— the LLM doesn't need to know the user's spouse's name in order to ask
about her preferences.

### 3.5 The intelligence layer

`intelligence/` adds the "ask my memory" surface:

- `QuestionEntity` — a user's natural-language query.
- `AnswerEntity` — an LLM-generated response.
- `ActionEntity` — derived actions or insights.

Cron jobs (`FeedQuestionQueueCron`, `FeedQueueCron`) pull unanswered
questions, call the LLM with `readKnowledge` available, and store
answers. This is essentially a **background reasoning loop** running over
the user's personal data — conceptually the same shape as OpenClaw's
dreaming or Mem0's auto-extraction, but rooted in the same database the
agents are reading.

## 4. The context-engineering thesis

Putting it all together, a personal AI agent has four context layers it
must compose for every turn, and CI-Server can fill each one:

### Layer 1 — Identity (frozen, ~1k tokens)

Who the user is, who they live with, what they value. CI-Server's
`UserContextService.getUserContextForLLM` returns exactly this shape:
`currentUser`, `familyMembers`, `topPreferences`, `quickStats`. The
companion-memory adapters surface it through:

- Hermes `system_prompt_block` → injected into the frozen prompt.
- MCP `companion_context` → callable at session start.
- OpenClaw skill triggers (`who is`, `what do I like`) → on-demand recall.

This is the "user dossier" pattern, and unlike Hermes' MEMORY.md / USER.md
markdown it's derived from real data — emails, contacts, social graph —
rather than from things the agent happened to write down in past sessions.

### Layer 2 — Relevance (per-turn prefetch, ~variable)

For the current query, pull the top-N relevant memories. This is
`companion_recall` and it uses the hybrid keyword+semantic search the
CI-Server already does. The Hermes plugin runs it as `prefetch(query)`
on every turn; the MCP server exposes it as a tool the LLM can call when
it decides retrieval is needed.

The retrieval is hybrid by default, so a query like "what was that
restaurant in Berlin?" gets:
- the BM25 hit on "Berlin" + "restaurant" through full-text,
- semantic hits on the user's notes that *mention* the city without saying
  "Berlin",
- graph traversal from Berlin's `PlaceEntity` to `VISITED` events.

A vector-only memory provider would miss the relational hop. A
graph-only provider would miss the semantic note. CI-Server returns all
three from one query against one database.

### Layer 3 — Reasoning (graph traversal, on demand)

Multi-hop queries — "who did I meet at the conference where I gave my
talk on memory?" — require traversal: from the talk Event, through
ORGANIZED_EVENT_WITH and PARTICIPATED_IN edges, to the people. The
`readKnowledge` tool exposes this directly to the LLM and bounds it
(maxDepth ≤ 3, maxNodes ≤ 200, maxEdges ≤ 500) so the response stays
within a reasonable prompt budget.

This is exactly the area where graph approaches beat vector approaches on
the benchmarks (+23 points on multi-hop in LoCoMo per the 2026 state-of-memory
report). A vector store cannot answer this without auxiliary join logic that
graph databases do as their primary mode.

### Layer 4 — Write-back (asynchronous, never blocking)

New facts learned during the turn — preferences, decisions, plans — get
written back via `companion_remember`. The Hermes plugin does this both
explicitly (when the model calls the tool) and implicitly (`sync_turn`
persists every conversation turn as a `Communication` entity on a daemon
thread). 2026 benchmarks identify async memory writes as table stakes — and
the existing graph-promotion event chain is already asynchronous, so we get
this for free.

## 5. Why this is more accurate, secure, performant, and tractable

### Accuracy

- **Multi-signal retrieval already in place.** Hybrid (BM25 + embedding +
  graph) is the dominant 2026 architecture; CI-Server has had it since
  `search-next` shipped.
- **Identity resolution is solved by ETL.** PersonEntity is upserted by
  email across all sources, so "John Smith" in Gmail = "John Smith" in
  Calendar = "John Smith" in Facebook. No cross-session identity drift.
- **Temporal context is first-class.** Every memory has `created_at` and
  `updated_at`; every event has `start_time`. Temporal reasoning — the
  hardest unsolved category in LongMemEval — has its native columns.
- **Specialized tools encode user intent.** `getFamilyMembers`,
  `getEntertainmentPreferences`, etc. let the LLM call intent-shaped APIs
  rather than constructing graph traversals by hand. Less reasoning load
  → fewer failures.

### Security

- **Data never leaves the user's homeserver.** Every cloud provider in the
  Hermes ecosystem (honcho, mem0, supermemory, retaindb) requires shipping
  personal data to a SaaS. Companion-memory adapters keep it local.
- **API-key auth at the controller layer.** The existing
  `JwtOrApiKeyAuthGuard` scopes every request to a user; no
  cross-tenant leakage even when multiple agents connect to the same
  backend.
- **Prompt-injection scanning.** Inherited from Hermes' built-in memory
  pattern; we can add a parallel scanning step in the MemoryController
  before persisting `description` text.
- **Auditable storage.** Memories are rows in Postgres with timestamps.
  Reviewable in SQL. Reversible by `forgetKnowledge`. Not a black box.

### Performance

- **One database round-trip per retrieval.** Graph + vector + FTS live in
  the same Postgres instance, so multi-signal retrieval is a single query
  per pass — no fan-out across vector store + graph store + cache.
- **Async write path.** The `GRAPH_NODE_UPSERTED` event chain doesn't block
  the responding turn.
- **Prefix caching preserved.** The Hermes `system_prompt_block` returns the
  same shape each session, which keeps the LLM's prompt-prefix cache warm.
  Companion-memory deliberately does not vary its system-prompt block per
  turn (only between sessions), preserving the cache hit rate Hermes was
  designed around.
- **No 2.3× latency penalty.** The 2026 graph-vs-vector benchmarks measure
  graph DBs hosted as separate services (Neo4j, Memgraph). CI-Server's
  graph extension (Apache AGE) is in the same Postgres process the
  application server is already querying.

### Tractability

- **The data model is the user's data, not the agent's.** When Claude Code
  writes a memory, it lands in the same graph the Hermes plugin reads and
  the OpenClaw skill traverses — and the web UI shows the user. No
  per-agent silos.
- **No re-ingest needed when adding an agent.** Plug in a new MCP host,
  reuse the existing graph. Contrast with cloud memory providers, where
  each new agent typically gets its own database.
- **One operational surface.** The CI-Server is already monitored,
  backed up, and migrated. Adding more agent surfaces does not add more
  databases to operate.
- **Migration story.** Moving from a cloud memory provider to
  companion-memory is a one-time import: read out the cloud provider's
  memories, write them via `companion_remember` in a script. Migrating
  the other direction (when the user upgrades to a different homeserver,
  or wants to share with a co-resident) is just a `pg_dump`.

## 6. Where the gaps still are

Honest accounting — these are the things we'd want to improve before
running the benchmarks in [benchmarking.md](./benchmarking.md):

1. **No native temporal-abstraction layer yet.** BEAM showed that even
   leading providers degrade 25% from 1M to 10M tokens of history because
   they don't compress temporal context. CI-Server has summaries
   (`summaries/`) but no formal time-bucketed dossier rollup yet.
2. **No structured claim/evidence layer.** OpenClaw's memory-wiki tracks
   `claim, evidence, confidence, contradictions, open-questions` as
   first-class. CI-Server's graph could carry this on entity properties,
   but no convention has been settled.
3. **Embeddings are best-effort.** The Ollama embedder is fine for local
   dev but not benchmarked against modern reranking pipelines. Adding a
   cross-encoder reranker on top of the hybrid retrieval would likely lift
   our LongMemEval scores by several points.
4. **No conversation/turn-level audit log surfaced to the user.** Writes
   happen but the user can't (yet) ask "show me every memory Claude Code
   wrote this week". This is a UI gap, not a data gap.
5. **No `dreaming`-equivalent background promotion.** The CI-Server has the
   intelligence cron jobs that could host this — but no policy yet for
   what gets promoted into the user-facing dossier vs what stays at the
   raw event level.

Each of these is a tractable extension on top of the existing graph
substrate, not a rearchitecture.

## 7. Putting it on the bench

The next document, [benchmarking.md](./benchmarking.md), proposes a
concrete plan for running LongMemEval and LoCoMo against companion-memory
versus the seven other Hermes-supported providers, including how we'd
adapt the question sets to a *personal* data domain and how we'd measure
the four properties — accuracy, security, performance, tractability — in
a way that doesn't trivially favour our own architecture.
