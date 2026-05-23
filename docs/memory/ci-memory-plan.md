# Companion Memory as a Memory Provider, MCP Server, and Skills Layer for Hermes & OpenClaw

**The bet.** Personal AI memory is the next infrastructure layer of the agent stack. Mem0 raised $24M (Basis Set, Kindred, YC) at a reported ~$150M valuation; Letta raised a $10M seed led by Felicis at a $70M post-money valuation; Plastic Labs (Honcho) raised $5.35M pre-seed (Variant, White Star, Betaworks); Supermemory raised $3M (Susa, Browder, SF1.vc + Jeff Dean angels); Zep has SOTA temporal-graph memory (per arXiv:2501.13956: "In the DMR benchmark, which the MemGPT team established as their primary evaluation metric, Zep demonstrates superior performance (94.8% vs 93.4%)" — and 98.2% with GPT-4o Mini); Cognee raised a $7.5M seed for graph-based AI memory. Meta acquired Limitless in December 2025, ending the pendant category and signaling that personal context is now a strategic concern for hyperscalers. Apple delayed personal-context Siri on March 7, 2025, to "the coming year" — the on-device personal-context graph is **the unsolved hard problem of AI right now.**

**CI's position.** CI already has what every competitor is trying to build: (1) a graph database of entities, (2) vector embeddings + semantic search, (3) HBPE and Personal Forecast predictive layers, (4) GraphQL→MCP auto-conversion, (5) local-first/uncloud architecture. Honcho's "dialectic" is a non-predictive shadow of HBPE. Mem0/Supermemory/Cognee are cloud-first and don't own the device. **CI's wedge is the personal black box: the only architecture that is local, graph-native, predictive, and ships as a consumer appliance.**

**The bottleneck.** Companion Hub installation.  

**The plan (steel thread, MVP v1 → v3).**
- **MVP v1 (steel thread):** REST endpoint on `agents.ci-domain`, API-key auth, receives paused-agent context, logs it, returns nothing. Hermes memory provider plugin + OpenClaw plugin wire it up. Post-install script in Ermy embeds the API key. Goal: prove the round trip without breaking the agent.
- **MVP v2 (functional retrieval):** Embed incoming context → semantic search on entity index → return top-K entities as plain text. Persist context as new memories (replaces deprecated in-app chat). K-hop=1–2 graph traversal with relationship typing. Hardware-tier auto-config for parallel small memory-side LLM (Qwen3-4B class on a secondary 8GB card).
- **v3 (differentiated / VC-ready):** Pre-warmed in-memory Postgres of Dunbar-120 contacts + top-1000 places. Two-shot inference (pre-LLM entity resolution → main LLM reasoning → post-LLM verification). Entity-ID tagging in prompts ("Steve Barry [id:p_182]" not "Steve Harvey"). Assumption vectorization for pronouns. HBPE/Personal Forecast predictive injection. Hyperlinked output cards. Parallel non-blocking vLLM. Sub-agent orchestration. Memory consolidation / "dream" jobs.
  Stand up the `agents.ci-domain` skeleton, scaffold the Hermes plugin repo (private), and run the post-install script design exercise — these unblock day-1 of plugin work the moment Hub clears its installer milestone.

---

## TL;DR

- **Build the steel-thread Hermes/OpenClaw memory provider plugin that pipes paused-agent context to CI's existing entity graph — but only after Companion Hub installation ships.** CI's HBPE + graph + local-first stack is already a superset of Honcho's dialectic and Mem0's two-phase pipeline; the work is exposure, not invention.
- **The defensible moat is the "personal black box" thesis: local-first, graph-native, predictive, appliance-shipped.** Every funded competitor is cloud-first (Mem0, Supermemory, Honcho-managed, Zep, Cognee) or hardware-without-memory-stack (Limitless got absorbed by Meta). CI is the only player credibly in all four quadrants.
- **Open-source the memory-provider plugin layer (MIT), keep CI-Server proprietary.** This mirrors how Mem0/Honcho/Cognee captured Hermes/OpenClaw plugin slots — distribution is via the plugin marketplace, not direct go-to-market. Cost of community management is real but bounded.

---

## Key Findings

### 1. The Hermes memory-provider plugin surface is a known, stable contract
Hermes Agent (Nous Research, MIT) ships eight bundled memory provider plugins (Honcho, OpenViking, Mem0, Hindsight, Holographic, RetainDB, ByteRover, Supermemory). The plugin contract is the `MemoryProvider` ABC in `agent/memory_provider.py`, registered through `plugins/memory/<name>/`. Required methods: `name`, `is_available()`, `initialize()`, `get_tool_schemas()`, `handle_tool_call()`, `get_config_schema()`, `save_config()`. Optional hooks (the ones that matter for prompt injection): `system_prompt_block()`, `prefetch(query)` (run before each LLM call, returns recalled context), `queue_prefetch(query)` (pre-warm after each turn), `sync_turn(user, assistant)` (persist conversation, **must be non-blocking**), `on_session_end()`, `on_pre_compress()` (save insights before compression discards them), `on_memory_write()`. Single-provider rule: only one external provider active at a time. Plugins live in `~/.hermes/plugins/memory/<name>/` or are pip-installed via the `hermes_agent.plugins` entry-point group.

### 2. OpenClaw uses a Markdown-first model with optional plugin overrides
OpenClaw's default memory is plain Markdown files in the agent workspace (`MEMORY.md`, `memory/YYYY-MM-DD.md`). The active memory plugin can be swapped via `plugins.slots.memory`. Plugins are npm-style packages (`openclaw.plugin.json` manifest + TypeScript), e.g. `openclaw plugins install @honcho-ai/openclaw-honcho`. OpenClaw also has **Active Memory** (a sub-agent that runs before main inference to surface context — closer to CI's intended pattern) and **Memory Wiki** (claim + evidence + contradiction tracking). The provider model is bring-your-own-tools: implement `memory_search` and `memory_get`, plus any specialty tools.

### 3. The competitive landscape segments into five tribes
| Tribe | Players | Defining trait |
|---|---|---|
| **Dialectic / user-modeling** | Honcho (Plastic Labs) | LLM-curated peer representation, "dreaming," dialectic chat — non-predictive |
| **Two-phase extraction** | Mem0, Supermemory | LLM extracts facts, ADD/UPDATE/DELETE/NOOP into a vector store |
| **Temporal knowledge graph** | Zep/Graphiti, Cognee | Bi-temporal edges, validity intervals, GraphRAG |
| **OS-style memory hierarchy** | Letta (MemGPT) | Core/archival/recall tiers, agent self-edits memory blocks |
| **Filesystem / markdown-native** | OpenViking, ByteRover, Holographic, Claude's memory tool, Anthropic Skills | L0/L1/L2 tiered loading or hierarchical context tree, human-readable files |

CI sits in a sixth tribe almost alone: **predictive + graph + local-first appliance**. Apple Intelligence is the closest analog architecturally but is cloud-augmented and consumer-only; the "personal-context Siri" launch was delayed on March 7, 2025, and pushed to Spring 2026.

### 4. Funding signal — memory is funded, but no one has shipped the consumer appliance
- **Mem0**: $24M Seed+A (Basis Set led A, Kindred led seed; YC, Peak XV, GitHub Fund). Per Mem0's Series A announcement (PR Newswire, Oct 28, 2025): **"41,000 GitHub stars and 14 million downloads, with API calls growing from 35 million in Q1 to 186 million in Q3 2025"** — a ~5× quarter-over-quarter growth that is the most compelling traction metric in this segment. TechCrunch adds "more than 80,000 developers have signed up for its cloud service." AWS Agent SDK exclusive memory provider. Reported ~$150M valuation.
- **Letta (MemGPT)**: $10M seed at $70M post-money, led by Felicis (Astasia Myers), Sep 23 2024. Institutional co-investors: **Sunflower Capital and Essence VC**. Angels: Jeff Dean, Clem Delangue (Hugging Face), Cristóbal Valenzuela (Runway), Jordan Tigani (MotherDuck), Tristan Handy (dbt Labs), Robert Nishihara (Anyscale), Barry McCardel (Hex). Per Myers (Felicis): "Letta's work addresses one of the most pressing challenges in AI today — effective memory management."
- **Plastic Labs (Honcho)**: $5.35M pre-seed, Apr 11 2025, Variant + White Star + Betaworks; angels Scott Moore, NiMA Asghari, Thomas Howell.
- **Supermemory**: $3M seed (Susa Ventures + Browder + SF1.vc + Dane Knecht/Cloudflare CTO, Jeff Dean, Logan Kilpatrick, David Cramer).
- **Cognee**: $7.5M seed (Pebblebed, 42CAP, Vermilion Cliffs + angels from Google DeepMind, n8n, Snowplow). >1M pipelines/month, 70+ companies.
- **Zep**: SOTA on Deep Memory Retrieval per their own paper (arXiv:2501.13956): "Zep demonstrates superior performance (94.8% vs 93.4%)" vs MemGPT; 98.2% with GPT-4o Mini. Graphiti open-sourced.
- **Limitless (ex-Rewind)**: ~$33M raised lifetime (a16z, Sam Altman angels), valued ~$367M in 2023, acquired by Meta on December 5, 2025. Pendant discontinued; team folded into Meta Reality Labs. **This is the single most important data point in the deck:** the hardware-pendant category collapsed within 18 months; Meta paid for the team, not the product.
- **Friend.com (Avi Schiffmann)**: $8.5M raised; ~3,000 pendants sold, ~1,000 shipped, ~$348K revenue per Fortune (Oct 2025); pivoted hardware-only after shutting down the web chatbot in Jan 2025; $1M NYC subway ad campaign Fall 2025.

### 5. Apple Intelligence is the architectural blueprint CI is already most of the way to
Apple's public design: a **semantic index** (on-device, indexes the meaning of files/photos/emails/messages via Core Spotlight), an **App Intents toolbox** (apps register entities + actions), and an **Orchestration / Private Cloud Compute** layer. The personal-context query path is exactly the two-shot pattern Liam described: (1) the semantic index resolves entities and salience pre-LLM, (2) the LLM reasons over a small, relevant slice, (3) the answer is verified against the structured data. **Apple has not yet shipped this** — Jacqueline Roy (Apple) told Daring Fireball on March 7, 2025: *"It's going to take us longer than we thought to deliver on these features and we anticipate rolling them out in the coming year."* Now expected Spring 2026 per MacRumors (June 12, 2025).

### 6. Honcho is the right benchmark — and a strict subset of HBPE
Honcho's architecture: peers (humans and agents as first-class), observer/observed collections, four background LLM agents (Deriver → extracts conclusions; Dialectic → answers; Summary → compresses; Dream → consolidates every ~8 hours). Tools exposed to Hermes: `honcho_profile`, `honcho_search`, `honcho_context`, `honcho_reasoning`, `honcho_conclude`. Two-layer context injection: base context (session summary + user representation + peer card) + dialectic supplement, three orthogonal knobs (contextCadence, dialecticCadence, dialecticDepth). Their custom 8B model **Neuromancer-XR** is, per Plastic Labs' blog: *"fine-tuned Qwen3-8B on these traces. The resulting model is Neuromancer XR (for eXplicit Reasoning) … currently in production powering the latest release of Honcho,"* claiming 88.4% overall accuracy on their internal benchmark — outperforming Claude 4 Sonnet. **What's missing from Honcho:** prediction (HBPE), real graph traversal, on-device-only operation (cloud LLM calls go to Anthropic/Gemini/OpenAI by default), entity-disambiguated structured queries.

### 7. The "two-shot inference" pattern is real and emergent
Apple Intelligence does it (semantic index → LLM → action), Anthropic's effective context engineering blog endorses **"just-in-time" retrieval over pre-stuffed context**, OpenClaw's Active Memory does a sub-agent pass before main inference, Honcho does base-context-then-dialectic. CI's v3 design — pre-LLM entity resolution → main inference → post-LLM verification — is converging design across the industry. **CI's differentiator is the predictive injection layer (HBPE/Personal Forecast) that no one else has.**

### 8. Local-LLM hardware tiers cleanly map to CI's intended deployment
Per benchmarks (localllm.in, BSWEN RTX 4060 benchmarks, arsturn.com): an **RTX 4060 / 2070 Super (8GB)** comfortably runs Qwen3-4B at 40+ tok/s and Qwen3-8B Q4_K_M at ~40.58 tok/s with 16K context (~7.2GB VRAM). An **RTX 3090 / 4090 (24GB)** runs Qwen3-30B-A3B (MoE, ~3.3B active, ~18.6GB at Q4_K_M) at ~72.9 tok/s. This is exactly Liam's split: small memory-side model on the secondary card, big primary model on the 24GB card. The architecture works.

---

## Details

### A. The Personal AI / Digital Twin Space — Market Landscape

**Cloud-first incumbents.** ChatGPT memory now spans "saved memories" + "chat history reference" — per Simon Willison's blog quoting OpenAI: *"Starting today [April 10th 2025], memory in ChatGPT can now reference all of your past chats to provide more personalized responses."* Both controllable via Settings; cross-session profile injected into Model Set Context section of the system prompt. Free-tier rollout followed on June 3, 2025. Claude memory launched Sep 2025 (Team/Enterprise), expanded to Pro/Max Oct 23 2025, free-tier March 2 2026; uses a file-based `/memories` directory with `CLAUDE.md` hierarchical convention; project-scoped memory. **Both are siloed and cloud-bound** — Claude's memory doesn't travel to other tools, ChatGPT's doesn't either. Mem0's pitch is "Plaid for memory" — a portable layer across models. CI's pitch is stronger: **portable AND local AND graph AND predictive.**

**Hardware-attached players (the lesson of the corpse pile).**
- **Limitless/Rewind**: Meta acquired Dec 5 2025. Pendant sales halted. Software (Rewind Mac app) sunset Dec 19 2025. Lifetime raise $33M, last valuation ~$367M (2023). **This is the cautionary tale: vertically integrated hardware-AI memory was unfundable as a standalone for the long run.**
- **Friend (Avi Schiffmann)**: $129 pendant, 3,000 sold / 1,000 shipped, $348K revenue per Fortune (Oct 2025). Avi's quote to Fortune: *"I don't have that much money left."* Burned $1M on subway ads.
- **Humane AI Pin**: Sold to HP (2025), product discontinued.
- **OMI / Friend (open-source)**, **Plaud**, **Tab.ai**: still in market, no breakout traction.

**Local-first sovereign-AI lane.**
- **Olares / Olares One**: Per Olares founder Michael Yuan (Medium, Dec 31, 2025): *"Just one week after launch, Olares One has rapidly surpassed $1 million in orders on the Kickstarter platform."* Final Kickstarter total: $2,343,324 from 816 backers (7,597% of $30,000 goal). RTX 5090M Mobile + 96GB RAM appliance, runs Olares OS (Kubernetes-based, sovereign-cloud); explicitly positioning as a "personal cloud, not a PC." Founder Peng Peng's quote (SiliconANGLE, Dec 9 2025): *"personal cloud solution, not a personal computer."* **This is the closest hardware analog to a CI appliance vision.**
- **Umbrel** (Bitcoin homelab adjacent), **Ollama** (model runner, not memory), **HomeAssistant** (smart home not memory).
- **CI's "uncloud" branding sits cleanly in this lane and is differentiated by being memory-first rather than infrastructure-first.**

**Knowledge-app players (semi-adjacent).**
- **Tana**, **Mem.ai**, **Reflect**, **Heyday**, **Granola** (meeting notes with memory). All notebook-first; none offer an agent-facing memory API.
- **Rewind.ai** (pre-Limitless pivot) was the closest — pure local OCR + audio + screen → searchable memory. Now dead.

**The gap CI is targeting: "personal black box / personal database appliance."** Nobody owns it. The funded competitors are cloud-first (Mem0, Honcho-managed, Supermemory, Zep, Cognee). The hardware players (Limitless, Friend) had no real memory architecture. Apple is delayed and consumer-locked. CI has the architecture, the local-first stance, and the predictive layer.

**Technical primitives emerging as standard:**
1. Vector memory (everyone)
2. Graph memory (Zep, Cognee, Mem0g, Honcho's collections, CI ✓)
3. Temporal memory (Zep's bi-temporal, ByteRover's AKL decay)
4. Episodic vs semantic split (Letta, Zep)
5. User modeling / theory-of-mind (Honcho — and CI's HBPE is a predictive superset)
6. Memory consolidation / sleep-time compute (Letta, Honcho dream, Mem0 update phase)
7. Eviction / decay (ByteRover AKL, Mem0 decay scoring, Honcho deletion)

### B. Technical Approaches to Personal AI Memory — A Decision Matrix

| Approach | Latency | Token cost | Implementation cost | CI fit |
|---|---|---|---|---|
| **Prompt injection / passive memory** (Honcho `context` mode, Mem0 auto-recall) | Add to every system prompt; cheap per call | Medium (must cap injection budget) | Low — just a prefetch hook | ✓ **MVP v2 default** |
| **Active MCP / tool-call retrieval** (CI today, Honcho `tools` mode) | Variable, model decides when to query | Low when model doesn't call, high when it does | Already have GraphQL→MCP | ✓ **Keep for power users** |
| **Pre-warmed in-memory cache** (Liam's Postgres-in-memory idea for top-120 Dunbar + top-1000 places) | Sub-10ms | Effectively free | Medium — needs warming jobs | ✓ **v3 differentiator** |
| **Two-shot inference / GraphRAG** (Apple Intelligence, Zep, CI v3) | Adds one short LLM call before main | Medium — small entity-extract LLM call | High — needs entity resolver + verifier | ✓ **v3 differentiator** |
| **Semantic context resolution** (entity disambiguation with ID tags) | Sub-100ms after warm | Negligible | Medium — needs entity-ID-tagging in prompt template | ✓ **v3** |
| **Behavior-tree sub-agent** (OpenClaw Active Memory) | Adds full sub-agent turn | High | High | Defer to v3+ |
| **Pronoun / assumption vectorization** | Sub-50ms | Negligible if cached | Medium — needs co-reference resolver | ✓ **v3** |
| **HBPE / Personal Forecast prediction** | Pre-computed background job | Effectively free per call | High — already built | ✓ **v3 unique** |
| **Episodic consolidation (sleep-like reflection)** | Off-hours batch | Medium per batch | Medium | ✓ **v3** — mirror Honcho "dream," Letta sleep-time, Mem0 update phase |

**Recommended composition for CI:**
- **MVP v1:** Active MCP only (existing) + new REST steel-thread endpoint
- **MVP v2:** Prompt injection (auto-prefetch) + persistence + K-hop graph traversal
- **v3:** Add pre-warmed cache + two-shot inference + entity-ID-tagged prompts + pronoun resolution + HBPE/Forecast injection + memory consolidation jobs

### C. CI Roadmap — MVP v1, v2, v3

#### MVP v1 — The Steel Thread

**Status:** PAUSED until Companion Hub installation ships and clears 1,000 downloads.

**Scope:** Prove the round trip. An agent on the user's machine pauses mid-generation, POSTs context to CI's memory server, server logs it, server returns nothing. The agent unpauses and continues. Zero behavior change for the user.

**Why this matters:** If the round trip can't be done without breaking the agent loop or blocking the user's response, nothing else in v2/v3 matters.

**Build list:**
1. **New REST endpoint** at `https://agents.ci-domain/v1/memory/context`
   - `POST` with JSON body `{session_id, user_id, agent_id, turn_index, messages: [...], timestamp}`
   - Header: `X-CI-API-Key: <key>`
   - Response: `204 No Content`
   - Implementation: thin FastAPI service in front of CI-Server's existing auth middleware; logs to console + writes to a temporary `context_log` table.
2. **Hermes memory provider plugin** (`hermes-companion-memory`)
   - File layout per Hermes spec:
     ```
     plugins/memory/companion/
     ├── __init__.py    # CompanionMemoryProvider + register()
     ├── plugin.yaml    # name: companion, version: 0.1.0, hooks: [sync_turn, on_session_end]
     ├── cli.py         # hermes companion status/setup
     └── README.md
     ```
   - `is_available()`: returns `bool(os.environ.get("COMPANION_API_KEY"))`
   - `prefetch(query)`: returns `""` (no-op in v1)
   - `sync_turn(user, assistant)`: spawns daemon thread, POSTs to `/v1/memory/context`
   - `get_config_schema()`: prompts for `api_key` (secret, env_var `COMPANION_API_KEY`, url `https://app.ci-domain/keys`) and `base_url` (default `https://agents.ci-domain`)
3. **OpenClaw plugin** (`openclaw-companion-memory`)
   - `openclaw.plugin.json` manifest + TypeScript stub
   - Implements `memory_search` (returns `[]` in v1) and `memory_get` (no-op)
   - Hooks into `agent_end` to POST session messages to the same endpoint
4. **Ermy post-install script** — When the user installs CI Hub Hermes (CI's Hermes-based desktop app launcher), the installer:
   - Calls CI's API for a per-user API key
   - Writes `COMPANION_API_KEY=<key>` to `~/.hermes/.env`
   - Sets `memory.provider: companion` in `~/.hermes/config.yaml`
   - Echoes "Companion Memory is now active. Visit app.ci-domain to manage."

**Steel-thread sequence diagram (ASCII):**
```
User ──prompt──▶ Hermes/OpenClaw ──pause + capture──▶ POST /v1/memory/context
                                                          │
                                                          ▼
                                                    [CI auth middleware]
                                                          │
                                                          ▼
                                                    [log + context_log row]
                                                          │
                                                          ▼  204 No Content
Hermes/OpenClaw ◀──unpause──────────────────────────────┘
        │
        ▼
   continues generation as if nothing happened
```

**Success metric:** 100% of Ermy installs route a full session of agent context to `/v1/memory/context` without dropped requests, with p99 round-trip latency under 200ms.

**Effort estimate:** 1.5–2 engineering-weeks for Hermes plugin + endpoint; 1 week for OpenClaw plugin; 0.5 week for post-install script.

**Risks:**
- Hermes plugin must not modify core files (Teknium rule, May 2026) — confirmed our design respects this.
- `sync_turn` MUST be non-blocking; daemon-thread pattern from Hermes docs is the proven approach.
- API key distribution in the post-install script is the security weak point — must scope keys to a single user/device, must allow revocation, must rate-limit aggressively.

#### MVP v2 — Functional Retrieval

**Status:** Begins after v1 ships and CI-Server's existing entity index is plumbed through.

**Scope:** Make memory actually useful. Incoming context gets embedded, semantically searched against the entity index, and a serialized plain-text list of top-K entities (people, places, events) is returned for prompt injection. Incoming context is persisted as memories (replacing the deprecated in-app chat). K-hop=1–2 graph traversal with semantic relationship typing is layered on.

**Build list:**
1. **Endpoint upgrade:** `/v1/memory/context` now returns JSON:
   ```json
   {
     "injection": "Recent context — known entities:\n- Steve Barry [p_182]: brother, lives in Boston, last contact 2026-05-18\n- Boulder, CO [pl_44]: visited 3x, last 2025-12\n...",
     "memory_id": "mem_8X4f...",
     "entities_used": ["p_182", "pl_44"]
   }
   ```
2. **Hermes plugin upgrade:** `prefetch(query)` now does the round trip and returns the `injection` string (gets concatenated into the system prompt by Hermes). Latency budget: 250ms p95.
3. **Persistence:** Every incoming context block becomes a new memory entity tied to `user_id`, with edges to all referenced people/places/events.
4. **Graph traversal:** Once top-K seed entities are identified by vector similarity, K-hop=1 expansion adds direct neighbors (filtered by relationship type: "family", "colleague", "place_visited"). K=2 only when relevance score crosses a threshold.
5. **Relevance threshold:** Don't inject if no entity scores above a configurable cosine similarity threshold (default 0.65). This prevents "token vomit" on unrelated queries.
6. **Hardware-aware auto-config:** On install, the Hub detects available GPUs and writes:
   - 1× GPU ≥ 24GB → primary model only, no memory-side LLM (use cosine sim only)
   - 1× GPU ≥ 24GB + 1× GPU ≥ 8GB → run small Qwen3-4B class on secondary card for entity extraction
   - 1× GPU ≥ 16GB → run primary smaller (Qwen3-14B Q4) + CPU embed
   - <16GB → embedding-only mode, no local LLM

**Hardware Tier → Model Assignment Table:**

| Tier | Memory-side GPU | Primary GPU | Memory-side model | Primary model | Notes |
|---|---|---|---|---|---|
| **Workstation** | RTX 4090 (24GB) | RTX 4090 (24GB) | Qwen3-8B / Neuromancer-XR style | Qwen3-30B-A3B Q4_K_M or Llama-3.3-70B Q4 | Two-card sweet spot — Liam's reference build |
| **Hobbyist** | RTX 2070 Super / 4060 (8GB) | RTX 4090 (24GB) | Qwen3-4B FP16 or Q8 | Qwen3-30B-A3B Q4 | The literal scenario Liam described |
| **Single 24GB** | (shared, time-sliced) | RTX 3090 / 4090 (24GB) | Qwen3-4B Q4 (paged) | Qwen3-14B Q4 | Time-slice, sequential |
| **Mid-tier** | (none) | RTX 4070 / 4080 (12–16GB) | CPU-only embeddings (BGE-M3) | Qwen3-14B Q4 | No LLM for memory ops |
| **Minimum** | (none) | iGPU / Apple Silicon | CPU-only embeddings | API-routed (Ollama or remote) | Embedding-only memory, no local primary |
| **Cloud fallback** | (none) | (none) | Cloud embeddings | Cloud LLM | Memory-server still runs locally; only inference is remote — preserves "uncloud" for data |

7. **Token budget:** Inject at most 1,200 tokens (matching Honcho's default ceiling).
8. **Replace deprecated chat:** Migrate any existing in-app chat data into the new memory store; deprecate UI.

**Success metrics:**
- Retrieval precision ≥ 70% on a 50-prompt internal eval set (Liam's life, Max's life, Steve's life as test cases)
- p95 prefetch latency under 250ms
- Zero token vomit (>1,200 token injections) over 1,000 sessions
- 100 Hermes/OpenClaw users actively running CI memory provider

**Effort estimate:** 3–4 engineer-weeks (assuming entity index and graph already exist in CI-Server).

**Open questions:**
- Should we expose `companion_search` and `companion_remember` as explicit tools (Honcho/Mem0 pattern) for power users, on top of auto-injection? **Yes, in v2.1.**
- Relationship-type taxonomy: do we ship a default ontology or learn it? **Ship a default of 30 types** (family, colleague, friend, place_visited, employer, etc.); learn additions later.

#### v3 — Differentiated / VC-Ready

**Status:** Begins after v2 has ~1,000 active CI memory provider users and a working entity-graph.

**Scope:** Build the differentiated stack that Honcho/Mem0/Supermemory can't match because they don't own the device or the predictive layer.

**Build list:**

1. **Pre-warmed in-memory Postgres of Dunbar-120 + top-1000 places.** On Hub startup, materialize the user's top 120 contacts (sorted by HBPE-derived contact frequency, recency, importance) and top 1,000 places (sorted by visit count, recency, semantic centrality) into an in-process pg_embedding cache. Queries against this hot set resolve in sub-10ms.
2. **Two-shot inference pattern:**
   ```
   ┌──────────────────────────────┐
   │ User prompt enters Hermes     │
   └────────────┬──────────────────┘
                │
                ▼
   ┌──────────────────────────────┐
   │ PRE-LLM (Memory-side small    │
   │ model on secondary GPU):      │
   │ • Entity resolution           │
   │ • Pronoun/assumption resolve  │
   │ • HBPE forecast injection     │
   └────────────┬──────────────────┘
                │  resolved prompt + entity IDs
                ▼
   ┌──────────────────────────────┐
   │ MAIN LLM (primary GPU):       │
   │ Reasons over resolved prompt  │
   └────────────┬──────────────────┘
                │  draft answer
                ▼
   ┌──────────────────────────────┐
   │ POST-LLM verifier (small):    │
   │ • Check entity claims         │
   │ • Validate against graph      │
   │ • Flag hallucinations         │
   └────────────┬──────────────────┘
                │
                ▼
   ┌──────────────────────────────┐
   │ Output with hyperlinked       │
   │ source-of-truth cards         │
   └──────────────────────────────┘
   ```
3. **Entity ID tagging.** Inject prompts as: "User said: 'Steve and I need to grab dinner.' Resolved entities: Steve = Steve Barry [p_182, brother, Boston]. Dinner = meal event, no place specified yet." This is the architectural answer to the "Steve Barry not Steve Harvey" disambiguation problem.
4. **Assumption vectorization for pronoun resolution.** Maintain a per-session vector of recent referents (last 5 entities mentioned); resolve pronouns by cosine against this vector + recency decay. Cheap, fast, and 80% as good as a proper coref model for personal-context use.
5. **Predictive context injection via HBPE / Personal Forecast.** When the user asks "what should I do this weekend?", inject not just past entities but predicted-likely activities/people/places from the Forecast model. **This is the single feature no one else has.**
6. **Hyperlinked output cards.** Every reasoning anchor in the response is hyperlinked to the source data in the graph — clickable in the Hermes/OpenClaw output if the platform supports rich content, or rendered as inline `[id:p_182]` tags otherwise.
7. **Parallel non-blocking vLLM execution.** Use vLLM continuous batching on the secondary GPU so multiple context queries (entity resolution, HBPE prediction, verification) run concurrently with the primary LLM's generation.
8. **Sub-agent orchestration for personal-life query trees.** For complex queries ("plan my week"), spawn typed sub-agents (calendar, friends, food, travel) that each query a slice of the graph, then aggregate. Each sub-agent uses the same memory-side small model.
9. **Memory consolidation / "dream" jobs.** Nightly batch (mirror Honcho's dream cadence — every ~8 hours): dedupe duplicate observations, decay edge weights, infer new edges (e.g., "Steve+Boston+monthly_visits → mom_lives_in_Boston"), evict observations older than threshold with no recent activations.
10. **Cache pre-fill / warming.** When the user opens a calendar event with someone, pre-warm that person's full subgraph into the cache.

**Token budget target:** Same 1,200-token ceiling, but with much higher signal-to-noise — the two-shot pattern means injection is targeted not blanket.

**Success metrics:**
- Retrieval precision ≥ 85% on the same eval set
- p95 end-to-end latency (pre-LLM + main + verifier) ≤ main-LLM-alone latency + 150ms
- Zero hallucinated entities in 1,000 production sessions (verifier catches them)
- Personal Forecast injection improves subjective relevance score by ≥ 20% in user study

**Effort estimate:** 8–12 engineer-weeks. This is the version that closes a Series A.

**Risks / Open questions:**
- vLLM + Ollama coexistence on the same machine — needs careful GPU allocation
- HBPE's prediction quality is the load-bearing assumption; if it's not good enough, v3 collapses to "fast Honcho"
- Verifier false positives could undercut model output quality; needs careful tuning
- Hyperlinked output cards depend on Hermes/OpenClaw supporting rich content — fallback is text tags

### D. Hermes & OpenClaw Plugin Implementation Spec

#### D.1. Hermes plugin file structure (`hermes-companion-memory`)

```
hermes-companion-memory/
├── plugin.yaml
├── pyproject.toml
├── __init__.py
├── provider.py          # CompanionMemoryProvider class
├── client.py            # HTTP client for agents.ci-domain
├── cli.py               # register_cli(subparser) — hermes companion <cmd>
├── tools.py             # companion_search, companion_remember tool handlers (v2+)
├── schemas.py           # tool schemas exposed to the LLM
├── README.md
└── tests/
    └── test_provider.py
```

**plugin.yaml:**
```yaml
name: companion
version: 0.1.0
description: "Companion Intelligence local-first personal memory. Predictive, graph-native, uncloud."
hooks:
  - prefetch
  - sync_turn
  - on_session_end
  - on_pre_compress
```

**Critical interface signatures (v1 minimum):**
```python
from agent.memory_provider import MemoryProvider
import os, threading, json
from .client import CompanionClient

class CompanionMemoryProvider(MemoryProvider):
    @property
    def name(self) -> str:
        return "companion"

    def is_available(self) -> bool:
        return bool(os.environ.get("COMPANION_API_KEY"))

    def initialize(self, session_id: str, **kwargs) -> None:
        self._api_key = os.environ["COMPANION_API_KEY"]
        self._base_url = os.environ.get("COMPANION_BASE_URL", "https://agents.ci-domain")
        self._session_id = session_id
        self._client = CompanionClient(self._base_url, self._api_key)
        self._sync_thread = None

    def prefetch(self, query: str) -> str:
        # v1: return "" (no-op).
        # v2: return self._client.fetch_injection(query, self._session_id)
        return ""

    def sync_turn(self, user_content: str, assistant_content: str) -> None:
        def _send():
            try:
                self._client.post_context(
                    session_id=self._session_id,
                    messages=[{"role":"user","content":user_content},
                              {"role":"assistant","content":assistant_content}],
                )
            except Exception as e:
                # NEVER crash the agent loop
                logger.warning("companion sync failed: %s", e)
        if self._sync_thread and self._sync_thread.is_alive():
            self._sync_thread.join(timeout=5.0)
        self._sync_thread = threading.Thread(target=_send, daemon=True)
        self._sync_thread.start()

    def get_config_schema(self):
        return [
            {"key":"api_key", "description":"Companion API key",
             "secret":True, "required":True, "env_var":"COMPANION_API_KEY",
             "url":"https://app.ci-domain/keys"},
            {"key":"base_url", "description":"Companion server URL",
             "default":"https://agents.ci-domain"},
        ]

    def get_tool_schemas(self):
        return []  # v1; v2 adds companion_search, companion_remember

    def handle_tool_call(self, name, args):
        return {"error":"no tools in v1"}

def register(ctx) -> None:
    ctx.register_memory_provider(CompanionMemoryProvider())
```

#### D.2. OpenClaw plugin file structure (`openclaw-companion-memory`)

```
openclaw-companion-memory/
├── package.json
├── openclaw.plugin.json
├── tsconfig.json
├── src/
│   ├── index.ts            # plugin entry
│   ├── provider.ts         # memory provider impl
│   ├── client.ts           # HTTP client
│   └── tools.ts            # memory_search, memory_get
├── README.md
└── tests/
```

**openclaw.plugin.json:**
```json
{
  "name": "@companion-intelligence/openclaw-memory",
  "version": "0.1.0",
  "type": "memory",
  "slot": "memory",
  "hooks": ["agent_end", "before_inference"],
  "tools": ["memory_search", "memory_get", "companion_remember"]
}
```

#### D.3. Post-install script for Ermy (CI's Hermes-based desktop app)

```bash
#!/usr/bin/env bash
# Ermy post-install — runs once after the user finishes Hub installation.
set -euo pipefail

ERMY_USER_ID="$(cat ~/.companion/user_id 2>/dev/null || true)"
if [ -z "$ERMY_USER_ID" ]; then
  echo "Companion user_id missing. Aborting memory provider setup."
  exit 1
fi

API_KEY="$(curl -s -X POST https://app.ci-domain/api/v1/keys \
  -H "Authorization: Bearer $(cat ~/.companion/install_token)" \
  -d "{\"name\":\"ermy-$(hostname)\",\"scope\":\"memory:rw\"}" \
  | jq -r '.api_key')"

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HERMES_HOME"

# Write env
grep -v '^COMPANION_API_KEY=' "$HERMES_HOME/.env" 2>/dev/null > "$HERMES_HOME/.env.new" || true
echo "COMPANION_API_KEY=$API_KEY" >> "$HERMES_HOME/.env.new"
mv "$HERMES_HOME/.env.new" "$HERMES_HOME/.env"

# Set provider
if [ -f "$HERMES_HOME/config.yaml" ]; then
  yq -i '.memory.provider = "companion"' "$HERMES_HOME/config.yaml"
else
  cat > "$HERMES_HOME/config.yaml" <<EOF
memory:
  provider: companion
EOF
fi

# Install the plugin
pip install --user hermes-companion-memory

echo "✓ Companion Memory active. Open Ermy to start; memories will persist locally to your Companion Hub."
```

**Declarative-setup alternative (no script execution):** Ship a `companion-memory.toml` config that Hub installs into `~/.hermes/plugins/companion/` alongside the plugin's own `plugin.yaml`. This is safer for users on locked-down OSes.

### E. VC Positioning Narrative

**The thesis.** "Every person needs a personal black box — a local database appliance that owns their memory, runs locally, integrates with every agent they touch, and predicts what they'll need next. Apple is delayed. The big labs are siloed. The pendant hardware companies died. CI is the only company building the operating layer."

**Comparable funding rounds in the space:**
| Company | Round | Lead | Valuation/Amount | What it tells us |
|---|---|---|---|---|
| Mem0 | Series A | Basis Set | $24M / ~$150M | Cloud memory infra is hot |
| Letta | Seed | Felicis (A. Myers) | $10M / $70M post | OS-style memory is hot |
| Cognee | Seed | Pebblebed | $7.5M | Graph memory is fundable |
| Plastic Labs (Honcho) | Pre-seed | Variant | $5.35M | Dialectic / identity layer is fundable |
| Supermemory | Seed | Susa | $3M | 19-year-old got $3M just for the framing |
| Limitless | Acquired | Meta | (undisclosed; ~$33M raised lifetime) | Hardware-attached pure-play didn't survive |
| Olares One | Kickstarter | n/a | $2.34M / 816 backers (7,597% goal) | Consumers will buy a local-AI appliance |

**Skating to where the puck is — venture-readiness signals.**
1. **Local-first / sovereignty narrative** — Olares hit $2.34M on Kickstarter on this exact wedge ("personal cloud, not a personal computer" — Peng Peng, SiliconANGLE Dec 9 2025).
2. **Predictive layer** — HBPE / Forecast is the moat no funded competitor has.
3. **Open-source go-to-market** — Mem0 went 41K stars before raising; Honcho's plugin landed in Hermes/OpenClaw before raising; Cognee built a plugin ecosystem.
4. **Plugged-in distribution** — Being a memory provider in Hermes/OpenClaw is distribution without burn. **This is the play.**
5. **Hardware/appliance optionality** — Olares One proves consumers will pay for a turnkey local AI box; CI doesn't need to build hardware but should position so the appliance is an obvious wedge later.

**Open-source strategy — DO IT.** Liam said "I'll put it up on GitHub, I don't care" and that's the right instinct. Specifically:
- **MIT-license the Hermes plugin and the OpenClaw plugin.** Zero risk; they're thin clients to your server. Mirrors Mem0's strategy.
- **Apache-2.0 a Companion Memory SDK** (Python + TypeScript) that talks to any CI-Server. This is what other developers will integrate.
- **Keep CI-Server's HBPE / Forecast / entity index core proprietary.** That's the moat.
- **Open-source a sample CI-Server-lite** that does v2-level retrieval (vector + semantic + simple graph) without HBPE — this is the "Honcho-equivalent" that gets community adoption. It's a calculated loss-leader.

**Community-management requirements (realistic).**
- 1 part-time community manager (could be Bennett or Anselm split time) for first 6 months
- A Discord with `#hermes-plugin`, `#openclaw-plugin`, `#sdk-help`, `#showcase`
- Weekly office hours
- Public roadmap (GitHub Projects)
- Within 12 months you'll need a dedicated DevRel hire if traction is real

**Differentiation against cloud-first incumbents:**
| Axis | Apple | OpenAI ChatGPT | Anthropic Claude | Mem0/Supermemory | **CI** |
|---|---|---|---|---|---|
| Local-first | Partial (semantic index on-device, LLM in PCC) | No | No | No | **Yes** |
| Predictive (HBPE/Forecast) | No | No | No | No | **Yes** |
| Graph-native | Limited | No | No | Mem0g optional | **Yes** |
| Cross-agent portable | No (Apple-only) | No (OpenAI-only) | No (Anthropic-only) | Yes | **Yes** |
| Open-source plugin | No | No | No | Yes (Mem0) | **Planned** |
| Consumer appliance | iPhone | No | No | No | **Yes (Hub roadmap)** |

---

## Recommendations

### Stage 1 — 2 — Steel thread (MVP v1) — Active when Hub clears trigger
1. Build and ship the v1 REST endpoint (1.5 weeks)
2. Build and ship the Hermes plugin (2 weeks)
3. Build and ship the OpenClaw plugin (1 week)
4. Build the Ermy post-install script (0.5 week)
5. **Trigger for Stage 3:** 100 active CI memory-provider users.

### Stage 3 — Functional retrieval (MVP v2) — 3–4 weeks
1. Upgrade endpoint to return injection JSON
2. Wire `prefetch()` into Hermes plugin
3. Persist incoming context as memories
4. Ship hardware-tier auto-config + small memory-side model deployment
5. Set up the internal eval set (Liam/Max/Steve scenarios)
6. **Trigger for Stage 4 / v3 / fundraise:** 1,000 active users AND retrieval precision ≥ 70% on eval set.

### Stage 4 — Differentiated v3 — 8–12 weeks, run in parallel with fundraise
1. Pre-warmed in-memory Postgres of Dunbar-120 contacts and top-1000 places (per Liam's spec)
2. Two-shot inference (pre-LLM resolver, post-LLM verifier)
3. Entity-ID tagging in prompt templates
4. Pronoun resolution via assumption vectorization
5. HBPE / Personal Forecast predictive injection — **the differentiator**
6. Hyperlinked output cards
7. vLLM parallel execution + sub-agent orchestration
8. Nightly memory consolidation (the "dream" job)

### Benchmarks that would change these recommendations
- If a competitor (Mem0, Honcho, etc.) ships a local-first appliance before CI ships v3: **accelerate v3 by cutting v2 scope.**
- If Hub stalls below 1,000 installs for 6 months: **rethink the distribution assumption** — consider shipping the Hermes plugin standalone with a CI-Server hosted-tier as the unlock.
- If Apple ships personal-context Siri ahead of Spring 2026: **double down on the cross-agent portable + uncloud framing**; Apple's win narrows the gap but doesn't close the cross-platform / cross-cloud / open-source angle.

---

## Caveats

- **Tooling versions move fast.** Hermes plugin contracts (Teknium's May 2026 "plugins MUST NOT modify core files" rule) and OpenClaw's plugin loader (the 2026.4.5 bug that broke `agent_end` hooks; fixed in 2026.4.6) drift. Pin to known-good versions in CI's plugin manifests.
- **Honcho is paywalled at depth.** Their Neuromancer-XR runs on Plastic Labs infra and the dialectic API hits their cloud LLM by default. Self-hosting works but requires you to provide an OpenAI/Anthropic key — which violates CI's uncloud posture. CI's full local-only stack is a real differentiator only if HBPE can run entirely on a local 8B-class model; this needs to be validated early.
- **Hardware projections are workload-dependent.** The Qwen3-30B-A3B @ 72.9 tok/s figure assumes Q4_K_M and ~3.3B active params; with longer context (16K+) or heavier reasoning load, throughput drops. The "Liam reference build" (24GB primary + 8GB secondary) is the right baseline but should be validated on real CI-Server workloads before being promised to users.
- **The Limitless acquisition is a double-edged signal.** It validates that personal memory matters enough for Meta to acquire — but the buyer was Meta, not Apple or OpenAI, and they bought the team and killed the product. This means: (a) personal memory is a strategic concern, but (b) hyperscalers will absorb point solutions rather than license them. CI's defensibility lives in the appliance / sovereignty story, not in a clean exit-to-hyperscaler narrative.
- **Predictive personal models (HBPE) are oversold across the industry.** Personal forecast is genuinely hard; even Apple's calendar/contact-aware Siri is delayed. CI should validate Forecast quality on internal test cases before promising it in v3 user-facing copy.
- **Open-sourcing creates support load.** Mem0 has 41K stars but also a queue of issues; Honcho ships at AGPL-3.0 partly to manage commercial use. Decide AGPL-vs-MIT before going public; recommend MIT for the plugin, AGPL-3.0 or commercial license for any CI-Server-lite reference implementation.
- **Some sources in this report are blog/news rather than primary technical docs** — particularly the Mem0g graph extraction details and ByteRover's LoCoMo numbers. Treat the architectural patterns as load-bearing but the specific accuracy percentages as marketing-influenced until independently reproduced.

---

##  Concrete Action List

 | Draft the Hermes plugin file structure in a private repo (`hermes-companion-memory`) — `plugin.yaml`, `__init__.py` skeleton, no behavior yet. Do NOT publish. |
 | Draft the OpenClaw plugin scaffold in `openclaw-companion-memory` — `openclaw.plugin.json`, `package.json`, TypeScript skeleton. |
  Draft the Ermy post-install script (the bash above is a starting point). Decide on API-key scoping (recommend per-device, revocable, rate-limited). |
  Generate the internal eval set — 50 personal-context prompts based on Liam's, Max's, Steve's actual lives, with ground-truth entity sets. Store in `eval/personal_context_v1.jsonl`. |
  Decide open-source license: recommend MIT for plugins, AGPL-3.0 for any CI-Server-lite reference. Add LICENSE files to private repos in anticipation of public launch. |
 Brief retrospective: are we on track for Hub install? If yes, plugin work stays parked. If Hub is slipping, replan. |
 
