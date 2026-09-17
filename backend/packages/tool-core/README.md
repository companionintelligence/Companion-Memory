# `@ci/tool-core`

The transport- and framework-independent core of CI's tool/intent system.

CI-Server's API is one NestJS application holding 54 domains, and `domains/tools`
is the one that three separate frontends need: the MCP server
(`src/domains/mcp`), the in-house LLM dispatcher, and eventually the `ci` CLI.
Before this package existed only the in-process ones could reach it, and the
consequence was not theoretical — the privacy label on a tool was enforced in
`McpToolService` alone, so whether it meant anything depended on which door a
caller came through. Moving the rule into `domains/tools` fixed that for
everything inside the Nest process. This package is the same move made once
more, for everything outside it.

**Nothing here imports `@nestjs/*`, TypeORM, or a database.** `tsconfig.json`
turns `experimentalDecorators` and `emitDecoratorMetadata` off, so a decorator
arriving in this package is a compile error rather than a silent dependency on
`reflect-metadata`. It has no runtime dependencies at all.

## What is in it

| | |
|---|---|
| **Vocabulary** | `IntentDefinition` and the `JSONSchema` it carries, `ToolResult`, `ToolError`, `ToolInvocationContext`, `intentToolName` |
| **Policy** | `capabilityAllows`, `capabilityRequiredFor`, `removesData`, `resolveDispatch`, `resolveToolGate`, `needsConfirmation` |
| **Registry** | `ToolRegistryCore` — the single chokepoint that applies that policy on every execution — and `outcomeOf` |
| **Ledger shape** | `ToolInvokedPayload`, `ToolInvocationOutcome`, `TOOL_INVOCATION_ERROR_MAX_LENGTH` |

## What is deliberately not in it

The 33 native tools (each is a thin wrapper over another domain's services),
`BaseTool`, the `ci.pending_actions` table and its services, `IntentCatalogService`,
and every Nest module, controller and entity. Those stay in
`backend/apps/api/src/domains/tools`, which also keeps a set of one-line
re-export shims so that the domain's public barrel exports the same names from
the same place it always did.

`domains/tools/events.ts` is the clearest example of the split: the event's
name, payload and outcome vocabulary are here, because a frontend outside the
process has to be able to read a ledger row — but the `defineEvent` call that
registers it on the appliance's durable bus stays there, because it reaches the
whole Nest module graph.

## Three seams

`ToolRegistryCore` has three collaborators, and each is a small interface rather
than a Nest class:

- `ToolCoreLogger` — four levels and a context name.
- `ToolInvocationSink` — where a finished invocation goes. The API sends it as
  `tool.invoked` on the `telemetry` queue; a CLI could append a line to a file.
- `ToolGate` — the confirmation queue's two-question protocol (`evaluate`,
  `propose`). The API implements it with `PendingActionService`.

`backend/apps/api/src/domains/tools/registry/ToolRegistry.ts` is the whole
adapter: a `@Injectable()` subclass that supplies those three and maps Nest's
lifecycle hooks onto `start()`/`stop()`.

## Three mirrored types, checked

`ToolCapability`, `ToolRequestContext` and `TrustDecision` restate types the API
owns (`ApiKeyCapability`, `RequestContext`, `PersonalizationDecision`). The
package cannot import them — each arrives with Nest attached. The two sides meet
structurally, and compile-time assertions in
`domains/tools/toolCoreContract.ts` and `domains/tools/policy/toolGate.ts` fail
the build if they ever stop being identical. One of them is a security
vocabulary, so "they happen to match today" was not good enough.

## Commands

```bash
yarn workspace @ci/tool-core test
yarn workspace @ci/tool-core typecheck
yarn workspace @ci/tool-core lint
yarn workspace @ci/tool-core build
```

`build` is `tsc --build`, emitting `dist/` with declarations. `@ci/be-api`
declares this package as a TypeScript project **reference**, so its own
`yarn build` builds this one first and compiles against the emitted `.d.ts` —
which is what keeps the API's output laid out as `dist/src/...`, the path the
Dockerfile's `CMD` names. Its `typecheck`, `dev` and `exec` scripts run
`tsc --build ../../packages/tool-core` first for the same reason; jest maps
`@ci/tool-core` to this package's **sources**, so the API's tests need no build.
