# Memory Providers — Comparison

A pragmatic look at the providers we considered and how the Companion
Intelligence memory layer relates to each.

## Summary table

| Provider          | Storage         | Cost          | Strengths                                       | Weaknesses for Companion Intelligence                          |
| ----------------- | --------------- | ------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| **companion-memory** | Self-hosted Postgres + AGE | Free, your hardware | Owns the data, shares with the rest of the CI graph, queryable from web UI, GraphQL, and every existing tool | Requires the CI-Server running locally / on the user's homeserver |
| Honcho            | Cloud           | Paid          | Multi-peer reasoning, dialectic loop, mature SDK | Data lives off-machine; per-peer model is heavyweight for single-user case |
| OpenViking        | Self-hosted     | Free          | Filesystem-paradigm, tiered L0/L1/L2 context    | Separate sidecar, no integration with CI graph                 |
| Mem0              | Cloud (managed) | Paid          | Auto-extraction, very low friction              | Off-machine; opaque storage; limited query power               |
| Hindsight         | Cloud or local  | Free/paid     | Knowledge graph + cross-encoder reranking       | Separate KG that duplicates CI's graph                         |
| Holographic       | Local SQLite    | Free          | Algebraic queries, zero deps                    | No multi-device sync; doesn't share with the rest of CI        |
| RetainDB          | Cloud           | $20/mo        | SOTA on LongMemEval                             | Off-machine; small writes API surface                          |
| ByteRover (`brv`) | Local Markdown  | Free          | Human-readable .brv/ tree, easy to grep         | Markdown-only; no graph; no API                                |
| Supermemory       | Cloud           | Paid          | Hybrid retrieval, container_tag scoping         | Off-machine; no graph                                          |

## What we borrowed

- **From Honcho**: the multi-surface "remember / recall / forget / context" tool
  shape. The companion-memory MCP server's tool names are intentionally close
  so prompts written for Honcho transfer with minimal edits.
- **From Mem0**: the implicit-write pattern in `sync_turn` — every turn is
  optionally archived without the agent having to think about it.
- **From RetainDB**: the `POST /context/query` + `POST /learn` two-call
  pattern; ours collapses to `POST /remember` + `GET /recall` over the same
  REST surface.
- **From Supermemory**: the namespace/container concept (`container_tag`); we
  expose it as `metadata.namespace`, settable via `COMPANION_MEMORY_NAMESPACE`.
- **From OpenViking**: the idea that memory should be on disk and inspectable
  — our backend keeps data in Postgres, but every tool also has a UI in the
  CI-Server web client, and the CLI tools can dump to JSON.
- **From OpenClaw's design**: SKILL.md + trigger-keyword discovery so an
  agent knows *when* to reach for these tools.

## What we deliberately did *not* copy

- **Provider-locked SDKs**. Companion-memory speaks plain HTTP + MCP, both
  open protocols. Anything that can `curl` can read and write the user's
  memory.
- **Single-active-provider lock-in**. The Hermes plugin still slots into the
  single-provider model required by `MemoryProvider`, but the underlying
  CI-Server can be used simultaneously by Claude Code, OpenClaw, and any
  other agent — there is no exclusivity per process.
- **Magic auto-extraction**. We do persist turns in `sync_turn`, but every
  write is explicit at the API layer; there is no hidden background LLM call
  that mines the conversation for "interesting" facts unless the user opts
  into it via a separate skill.

## When to use what

- **You already run a CI-Server**: use companion-memory. Everything else is
  duplicate state.
- **You only want a tiny local KV memory**: ByteRover or Holographic are
  simpler.
- **You want managed cloud memory you don't operate**: Honcho or Mem0.
- **You want best-in-class benchmark recall**: RetainDB or Hindsight.

Nothing stops you from running companion-memory alongside one of the cloud
providers if you want belt-and-suspenders persistence; the Hermes plugin
contract only allows one provider per Hermes process, but each surface
(Claude Code, OpenClaw, Hermes-with-different-provider) is independent.

## Sources

- [Hermes memory providers reference](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)
- [Hermes memory-provider plugin contract](https://hermes-agent.nousresearch.com/docs/developer-guide/memory-provider-plugin)
- [OpenClaw memory concepts](https://docs.openclaw.ai/concepts/memory)
- [Honcho overview](https://honcho.dev/docs/v3/documentation/introduction/overview)
- [Mem0 open-source overview](https://docs.mem0.ai/open-source/overview)
- [Supermemory quickstart](https://supermemory.ai/docs/quickstart)
- [Hindsight paper](https://arxiv.org/abs/2512.12818)
- [ByteRover CLI](https://github.com/campfirein/byterover-cli)
- [OpenViking GitHub](https://github.com/volcengine/OpenViking)
