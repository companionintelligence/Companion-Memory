# @companion-intelligence/openclaw-memory

Companion Intelligence memory provider plugin for [OpenClaw](https://openclaw.dev).

## Installation

```bash
npm install @companion-intelligence/openclaw-memory
```

## Configuration

Set your API key as an environment variable:

```bash
export COMPANION_API_KEY="your-api-key"
export COMPANION_BASE_URL="https://api.companion.intelligence"  # optional
```

## Usage

```typescript
import { createPlugin } from "@companion-intelligence/openclaw-memory";

const plugin = createPlugin({
  apiKey: process.env.COMPANION_API_KEY!,
  // baseUrl defaults to https://api.companion.intelligence
});

// Register with OpenClaw
openClaw.use(plugin);
```

Or use the provider directly:

```typescript
import { CompanionMemoryProvider } from "@companion-intelligence/openclaw-memory";

const provider = new CompanionMemoryProvider({
  apiKey: process.env.COMPANION_API_KEY!,
});

// On session end — persist the full conversation
await provider.onAgentEnd(sessionId, messages);

// Explicit store
await provider.companionRemember("Alice prefers oat milk", sessionId);
```

## Tools

The plugin registers three tools with OpenClaw:

| Tool | v1 | v2 |
|---|---|---|
| `memory_search` | stub (empty results) | real graph search |
| `memory_get` | stub (returns null) | fetch by ID |
| `companion_remember` | live (fire-and-forget POST) | + structured graph upsert |

## Building

```bash
npm run build
```

## License

MIT
