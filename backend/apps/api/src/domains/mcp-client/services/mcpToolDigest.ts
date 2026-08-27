import { createHash } from 'node:crypto';

import type { McpApprovedTool, McpDiscoveredTool, McpToolApproval, McpToolApprovalState } from '../types';

/**
 * The pinning primitive: turn one tool's `inputSchema` into a stable digest that changes when its
 * CAPABILITY changes and not when its prose does.
 *
 * Deliberately a standalone, dependency-free module rather than a method on the manager or the
 * provider — the digest is the contract three call sites have to agree on byte for byte (the
 * provider's intersect, the approve endpoint's "is this still the schema you were shown" check, and
 * the settings UI's drift badge), and a single pure function is the only way to keep them from
 * drifting apart.
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
export function canonicalizeSchema(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeSchema(entry));
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(source).sort()) {
    if (NON_CAPABILITY_KEYS.has(key)) {
      continue;
    }

    out[key] = canonicalizeSchema(source[key]);
  }

  return out;
}

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

  return match != null && match.schemaDigest === computeSchemaDigest(tool);
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
    const match = approvedByName.get(tool.name);

    let state: McpToolApprovalState;

    if (approved == null) {
      state = 'legacy';
    } else if (!match) {
      state = 'new';
    } else if (match.schemaDigest !== schemaDigest) {
      state = 'schema_changed';
    } else {
      state = 'approved';
    }

    out.push({
      name: tool.name,
      schemaDigest,
      state,
      approvedAt: match?.approvedAt ?? null,
      approvedDigest: match?.schemaDigest ?? null,
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
      state: 'unavailable',
      approvedAt: entry.approvedAt ?? null,
      approvedDigest: entry.schemaDigest,
    });
  }

  return out;
}

/**
 * The approval set a "approve everything this server currently offers" click produces.
 *
 * Preserves the ORIGINAL `approvedAt`/`approvedBy` of any tool whose digest is unchanged — a bulk
 * re-approval after one tool drifted must not rewrite the provenance of the other twenty, or the
 * audit value of the column evaporates on first use.
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
    const prior = existingByName.get(tool.name);

    if (prior && prior.schemaDigest === schemaDigest) {
      return prior;
    }

    return { name: tool.name, schemaDigest, approvedAt, approvedBy };
  });
}
