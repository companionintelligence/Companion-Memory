# Companion Memory

The CI-Server doubles as a personal memory backend for any agent that speaks
HTTP, MCP, or a Hermes/OpenClaw plugin. This directory documents that surface.

## What you get

```
            ┌────────────────────────────────────────────────────┐
            │              CI-Server (this repo)                 │
            │  /api/memory/{remember,recall,list,forget,context} │
            └────────────────────────────────────────────────────┘
                │                  │                   │
                │                  │                   │
        ┌───────┴────────┐ ┌───────┴────────┐ ┌────────┴─────────┐
        │ companion-     │ │ hermes-        │ │ openclaw-        │
        │ memory MCP     │ │ companion-     │ │ companion-       │
        │ (stdio)        │ │ memory plugin  │ │ memory skill     │
        └────────────────┘ └────────────────┘ └──────────────────┘
                │                  │                   │
        ┌───────┴────────┐ ┌───────┴────────┐ ┌────────┴─────────┐
        │ Claude Code,   │ │ Hermes Agent   │ │ OpenClaw         │
        │ Claude Desktop │ │ (Nous)         │ │                  │
        │ Cursor, ...    │ │                │ │                  │
        └────────────────┘ └────────────────┘ └──────────────────┘
```

All three surfaces talk to the same REST API — so a memory you store via
Claude Code is visible to Hermes and to OpenClaw, and vice-versa.

## Documents

| File                                                 | What it covers                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| [ci-memory-plan.md](./ci-memory-plan.md)             | **Strategic roadmap** — v1 / v2 / v3 stages, market landscape, hardware tiers, VC framing. Read this first. |
| [status-and-gaps.md](./status-and-gaps.md)           | **Where we are vs the plan** — what this PR delivers (✅ / 🟡 / ❌) stage by stage, plus next concrete actions. |
| [architecture.md](./architecture.md)                 | The memory data model, REST surface, and how the adapters compose.            |
| [context-engineering.md](./context-engineering.md)   | Deep dive — Hermes + OpenClaw memory internals, CI-Server as a personal database, and the four-layer context-engineering thesis. |
| [benchmarking.md](./benchmarking.md)                 | Concrete plan for proving the system is more accurate, secure, performant, and tractable. Datasets (LongMemEval / LoCoMo / a new CI-DOSSIER personal-data set), metrics, and provider matrix. |
| [providers-comparison.md](./providers-comparison.md) | Companion-memory vs honcho, mem0, openviking, supermemory, etc.               |
| [mcp-integration.md](./mcp-integration.md)           | Wiring the MCP server into Claude Code, Claude Desktop, Cursor.               |
| [hermes-integration.md](./hermes-integration.md)     | Installing the Hermes plugin and the `MemoryProvider` contract.               |
| [openclaw-integration.md](./openclaw-integration.md) | Installing the OpenClaw skill and using it from a workspace.                  |
| [troubleshooting.md](./troubleshooting.md)            | Common failures and how to debug them.                                        |

## Quick start

```bash
# 1. Mint an API key (one-shot)
CI_SERVER_JWT="$(make gentoken)" \
  bash scripts/companion-memory/mint-api-key.sh "companion-memory"

# 2. Install all three surfaces (skip those you don't use)
COMPANION_MEMORY_API_KEY=ci_xxx \
  ./scripts/install-companion-memory.sh --all

# 3. Smoke-test the round-trip
COMPANION_MEMORY_API_KEY=ci_xxx \
  ./scripts/companion-memory-smoke-test.sh
```

## Why a single backend?

Every other memory provider in the Hermes ecosystem (honcho, mem0, supermemory,
…) is **its own** silo. The Companion Intelligence pitch is that your personal
data already lives in one place — the user's homeserver — and that any agent
working on your behalf should read and write through that same store.
