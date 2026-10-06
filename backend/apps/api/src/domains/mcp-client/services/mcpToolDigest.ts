import { createHash } from 'node:crypto';

import type { McpApprovedTool, McpDiscoveredTool, McpToolApproval, McpToolApprovalState } from '../types';

/**
 * The pinning primitives. An approval pins two digests of a tool:
 *
 * - the SCHEMA digest ({@link computeSchemaDigest}) over its `inputSchema` with the prose stripped,
 *   which changes when its CAPABILITY changes;
 * - the DESCRIPTION digest ({@link computeDescriptionDigest}) over everything the chat model reads
 *   of it: title, description, and the input schema prose included.
 *
 * The second exists because the prose is the part the model acts on. With only the first pinned, a
 * server could keep a tool's schema and swap its description for new instructions on any
 * reconnect, and the tool stayed approved with no badge in Settings.
 *
 * Deliberately a standalone, dependency-free module rather than a method on the manager or the
 * provider — the digests are the contract three call sites have to agree on byte for byte (the
 * provider's intersect, the approve endpoint's "is this still what you were shown" check, and
 * the settings UI's drift badge), and pure functions are the only way to keep them from drifting
 * apart.
 */

/** Keys stripped before digesting: human prose, never a capability. */
const NON_CAPABILITY_KEYS = new Set(['description', 'title', '$comment', 'examples']);

/**
 * Recursively canonicalise a JSON Schema fragment:
 * - object keys sorted, so `{a,b}` and `{b,a}` digest identically (JS object key order is insertion
 *   order, and a JSON round-trip through Postgres jsonb does not preserve it);
 * - {@link NON_CAPABILITY_KEYS} dropped at every depth;
 * - array order PRESERVED — in JSON Schema, order is meaning (`required`, `enum`, `prefixItems`,
 *   `anyOf` branch precedence), so sorting arrays would hide a real change.
 *
 * `undefined` is normalised to `null` because `JSON.stringify` drops undefined object values but
 * renders undefined array entries as `null`; normalising up front makes the two agree.
 */
export function canonicalizeSchema(
  value: unknown,
  dropped: ReadonlySet<string> = NON_CAPABILITY_KEYS,
): unknown {
  if (value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeSchema(entry, dropped));
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(source).sort()) {
    if (dropped.has(key)) {
      continue;
    }

    out[key] = canonicalizeSchema(source[key], dropped);
  }

  return out;
}

const KEEP_EVERYTHING: ReadonlySet<string> = new Set();

/**
 * sha256 (hex) over the canonicalised `inputSchema`.
 *
 * The tool NAME is intentionally not part of the digest: the name is the approval's key, and mixing
 * it in would mean a rename could never be reported as "this tool is new" — it would surface as a
 * changed digest on a name that no longer exists.
 */
export function computeSchemaDigest(tool: Pick<McpDiscoveredTool, 'inputSchema'>): string {
  const canonical = canonicalizeSchema(tool.inputSchema ?? {});

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * sha256 (hex) over what the chat model is shown of a tool: its title, its description, and its
 * whole `inputSchema`, prose included (keys sorted, array order kept, as for the schema digest).
 *
 * A superset of the schema digest's input, so a capability change moves both. The approval state
 * reports `schema_changed` first in that case, since that is the bigger change to review.
 */
export function computeDescriptionDigest(
  tool: Pick<McpDiscoveredTool, 'title' | 'description' | 'inputSchema'>,
): string {
  const canonical = canonicalizeSchema(
    { title: tool.title ?? null, description: tool.description ?? null, inputSchema: tool.inputSchema ?? {} },
    KEEP_EVERYTHING,
  );

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Whether an approval still covers the tool's prose. An approval made before descriptions were
 * pinned carries no description digest; it covers the prose until {@link pinApprovedDescriptions}
 * fills one in on the next connect.
 */
function descriptionMatches(entry: McpApprovedTool, descriptionDigest: string): boolean {
  return entry.descriptionDigest == null || entry.descriptionDigest === descriptionDigest;
}

/**
 * Is this discovered tool covered by the stored approval set?
 *
 * `approved === null` is the legacy passthrough documented in
 * `20260826205522_add_approved_tools_to_mcp_server_configs.sql`: a row written before the approval
 * gate existed keeps working until its next successful connect grandfathers it. `[]` is NOT the
 * same thing — it means gated, nothing approved, no tool passes.
 */
export function isToolApproved(
  tool: McpDiscoveredTool,
  approved: McpApprovedTool[] | null | undefined,
): boolean {
  if (approved == null) {
    return true;
  }

  const match = approved.find((entry) => entry.name === tool.name);

  return (
    match != null &&
    match.schemaDigest === computeSchemaDigest(tool) &&
    descriptionMatches(match, computeDescriptionDigest(tool))
  );
}

/**
 * Per-tool approval state for the settings UI, over the union of what the server currently offers
 * and what was previously approved.
 *
 * `unavailable` entries (approved but no longer offered) are included on purpose: an approval the
 * upstream server has quietly stopped backing is exactly the kind of thing a person reviewing this
 * screen should be able to see and clear, and omitting them would make the stored grant invisible.
 */
export function buildToolApprovals(
  discovered: McpDiscoveredTool[] | null | undefined,
  approved: McpApprovedTool[] | null | undefined,
): McpToolApproval[] {
  const approvedByName = new Map((approved ?? []).map((entry) => [entry.name, entry]));
  const out: McpToolApproval[] = [];

  for (const tool of discovered ?? []) {
    const schemaDigest = computeSchemaDigest(tool);
    const descriptionDigest = computeDescriptionDigest(tool);
    const match = approvedByName.get(tool.name);

    let state: McpToolApprovalState;

    if (approved == null) {
      state = 'legacy';
    } else if (!match) {
      state = 'new';
    } else if (match.schemaDigest !== schemaDigest) {
      state = 'schema_changed';
    } else if (!descriptionMatches(match, descriptionDigest)) {
      state = 'description_changed';
    } else {
      state = 'approved';
    }

    out.push({
      name: tool.name,
      schemaDigest,
      descriptionDigest,
      state,
      approvedAt: match?.approvedAt ?? null,
      approvedDigest: match?.schemaDigest ?? null,
      approvedDescriptionDigest: match?.descriptionDigest ?? null,
    });
  }

  const discoveredNames = new Set((discovered ?? []).map((tool) => tool.name));

  for (const entry of approved ?? []) {
    if (discoveredNames.has(entry.name)) {
      continue;
    }

    out.push({
      name: entry.name,
      schemaDigest: null,
      descriptionDigest: null,
      state: 'unavailable',
      approvedAt: entry.approvedAt ?? null,
      approvedDigest: entry.schemaDigest,
      approvedDescriptionDigest: entry.descriptionDigest ?? null,
    });
  }

  return out;
}

/**
 * The approval set a "approve everything this server currently offers" click produces.
 *
 * Preserves the ORIGINAL `approvedAt`/`approvedBy` of any tool whose digests are unchanged — a bulk
 * re-approval after one tool drifted must not rewrite the provenance of the other twenty, or the
 * audit value of the column evaporates on first use. Every entry comes back with both digests.
 */
export function grandfatherApprovals(
  discovered: McpDiscoveredTool[] | null | undefined,
  existing: McpApprovedTool[] | null | undefined,
  approvedBy: string,
  approvedAt: string,
): McpApprovedTool[] {
  const existingByName = new Map((existing ?? []).map((entry) => [entry.name, entry]));

  return (discovered ?? []).map((tool) => {
    const schemaDigest = computeSchemaDigest(tool);
    const descriptionDigest = computeDescriptionDigest(tool);
    const prior = existingByName.get(tool.name);

    if (prior && prior.schemaDigest === schemaDigest && descriptionMatches(prior, descriptionDigest)) {
      return { ...prior, descriptionDigest };
    }

    return { name: tool.name, schemaDigest, descriptionDigest, approvedAt, approvedBy };
  });
}

/**
 * Fill in the description digest of every approval made before descriptions were pinned, from
 * the tools as they were last discovered, so that the NEXT `tools/list` is compared against the
 * prose the owner was living with rather than whatever it says now.
 *
 * Called on connect with the `discovered_tools` stored by the previous connect, before the fresh
 * list replaces them. Only an entry whose schema digest still matches is pinned: one that no longer
 * matches is already `schema_changed` and is pinned when it is approved again. Returns `null` when
 * nothing needed pinning, so the caller can skip the write.
 *
 * This is the upgrade path. Without it, every approval on the appliance would read as
 * `description_changed` on the first boot after this shipped and withhold every tool until someone
 * re-approved it; with it, existing approvals keep working, and a description that changes after
 * the upgrade is caught.
 *
 * `currentlyDiscovered` is this connect's list, read for one thing only: the title. Rows stored
 * before descriptions were pinned never kept one, so a previous tool without a title takes the
 * title this connect reports. Pinned without it, every titled tool would read as
 * `description_changed` on that same connect, which is the failure this function exists to avoid.
 */
export function pinApprovedDescriptions(
  approved: McpApprovedTool[] | null | undefined,
  previouslyDiscovered: McpDiscoveredTool[] | null | undefined,
  currentlyDiscovered?: McpDiscoveredTool[] | null,
): McpApprovedTool[] | null {
  if (approved == null || !approved.some((entry) => entry.descriptionDigest == null)) {
    return null;
  }

  const discoveredByName = new Map((previouslyDiscovered ?? []).map((tool) => [tool.name, tool]));
  const currentTitles = new Map((currentlyDiscovered ?? []).map((tool) => [tool.name, tool.title]));
  let changed = false;

  const next = approved.map((entry) => {
    const tool = discoveredByName.get(entry.name);

    if (entry.descriptionDigest != null || !tool || computeSchemaDigest(tool) !== entry.schemaDigest) {
      return entry;
    }

    changed = true;

    const title = tool.title ?? currentTitles.get(entry.name);

    return { ...entry, descriptionDigest: computeDescriptionDigest({ ...tool, title }) };
  });

  return changed ? next : null;
}
