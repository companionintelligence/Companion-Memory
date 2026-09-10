/**
 * The tool/intent vocabulary. **Defined in `@ci/tool-core`; re-exported here.**
 *
 * Every one of these types moved into the package because all three of this repo's tool frontends
 * need them and none of them needs Nest to have them: the MCP server, the LLM dispatcher, and a
 * CLI that does not exist yet. This file stays so that the ~50 modules inside this domain — the 33
 * tools above all — keep importing `../core/types` rather than all being rewritten at once, and so
 * that the domain's public barrel keeps exporting the same names from the same place.
 *
 * Add a NEW tool type to the package, not to this file. The one thing that legitimately belongs
 * here is an alias that ties a package type to an API-side one; there is exactly one of those
 * today, and it is asserted rather than assumed — see `../toolCoreContract.ts`.
 */
export {
  DISPATCH_TIERS,
  TOOL_PRINCIPALS,
  canonicalizeExecutableToolName,
  intentToolName,
  type CiEntityType,
  type DispatchTier,
  type IntentAccess,
  type IntentDefinition,
  type IntentDomainKey,
  type IntentPrivacy,
  type IntentSensitivity,
  type JSONSchema,
  type ToolError,
  type ToolExample,
  type ToolExecutionContext,
  type ToolInvocationContext,
  type ToolPrincipal,
  type ToolResult,
  type ToolSchema,
} from '@ci/tool-core';

/**
 * The GraphQL field-extension key a resolver declares its {@link IntentPrivacy} under.
 *
 * Lives here, beside the privacy contract itself, rather than in `domains/graphql`: both
 * `domains/graphql` (which writes it, via the `@GraphqlPrivacy` decorator) and `domains/mcp`
 * (whose `GraphQLToolAdapter` reads it) need the same string, and `no-cross-domain-internals`
 * forbids either reaching into the other's internals for it. `domains/tools` is the barrel they
 * already share for `IntentPrivacy`.
 */
export const GRAPHQL_PRIVACY_EXTENSION = 'ciPrivacy' as const;
