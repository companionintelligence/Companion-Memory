/**
 * Tool namespacing for MCP-client-sourced tools.
 *
 * A discovered tool becomes the dotted intent id `mcp.<serverSlug>.<toolName>` (later turned into
 * the executable name by {@link intentToolName}, dots → underscores). Both halves are
 * server-controlled data — a catalog slug a user typed, or a raw tool name reported by someone
 * else's `tools/list` — so both are sanitized to `[a-zA-Z0-9_-]` before being spliced into a name
 * that also has to survive the executable-name regex and not collide with a native intent.
 */

const UNSAFE_CHARS = /[^a-zA-Z0-9_-]+/g;

/** Collapse any run of disallowed characters to `_`, trim leading/trailing `_`, never return empty. */
export function sanitizeMcpIdentifier(raw: string): string {
  const cleaned = raw.replace(UNSAFE_CHARS, '_').replace(/^_+|_+$/g, '');

  return cleaned.length > 0 ? cleaned : 'x';
}

/** Build the dotted intent id for one discovered MCP tool. */
export function buildMcpIntentName(serverSlug: string, rawToolName: string): string {
  return `mcp.${sanitizeMcpIdentifier(serverSlug)}.${sanitizeMcpIdentifier(rawToolName)}`;
}
