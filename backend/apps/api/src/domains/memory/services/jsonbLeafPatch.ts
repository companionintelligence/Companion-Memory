/**
 * SQL builder for leaf-level JSONB patches.
 *
 * `properties || :patch::jsonb` is a *shallow* top-level merge: sending a whole
 * sub-object (`{ planner: { ...priorPlanner, trust_mode } }`) means the writer
 * first read `priorPlanner` in the application, so two writers touching
 * different leaves of the same sub-object lose each other's update — the second
 * one to commit resurrects the value it read before the first one landed.
 *
 * This builder writes one leaf at a time with `jsonb_set(..., path, value,
 * true)`, so the only thing a statement replaces is the exact leaf it names.
 * Nothing is read in the application, so concurrent writers to *different*
 * leaves of the same sub-object cannot clobber each other.
 *
 * `jsonb_set` cannot create intermediate containers, so every ancestor of every
 * leaf is materialised first from the row's current value (inside the same
 * statement, hence still race-free). A non-object sitting at an ancestor path is
 * replaced with `{}` rather than raising `cannot set path in scalar`.
 */
export type JsonbLeafPatch = {
  /** Full path to the leaf, e.g. `['planner', 'trust_mode']`. */
  path: string[];
  /** Any JSON-serialisable value. `null` writes a JSON null (it does not remove the key). */
  value: unknown;
};

export type JsonbLeafPatchSql = {
  /** SQL expression to assign to the JSONB column. */
  expression: string;
  /** Named parameters the expression references. */
  parameters: Record<string, unknown>;
};

function assertPath(path: string[]): void {
  if (path.length < 2) {
    throw new Error(
      `jsonb leaf patch path must name a nested leaf (at least 2 segments), got [${path.join(', ')}]`,
    );
  }

  for (const segment of path) {
    if (typeof segment !== 'string' || segment === '') {
      throw new Error(`jsonb leaf patch path segments must be non-empty strings, got [${path.join(', ')}]`);
    }
  }
}

/**
 * Build `{ expression, parameters }` for a set of leaf writes against `column`.
 *
 * Paths are passed as `text[]` parameters, never interpolated, so segment
 * content can never reach the SQL text.
 *
 * Top-level keys are deliberately rejected: `PersonService.patch` mirrors some
 * top-level property keys onto typed columns (`first_name`, `is_self`, …) and
 * this builder does not, so a single-segment path here would silently desync
 * them. Use `patch()` for those.
 */
export function buildJsonbLeafPatchSql(
  column: string,
  leaves: JsonbLeafPatch[],
  prefix = 'jsonbLeaf',
): JsonbLeafPatchSql {
  if (leaves.length === 0) {
    throw new Error('jsonb leaf patch requires at least one leaf');
  }

  for (const leaf of leaves) {
    assertPath(leaf.path);
  }

  const parameters: Record<string, unknown> = {};

  // Every ancestor container that has to exist before a leaf can be set,
  // shallowest first so `{a}` is created before `{a,b}`.
  const ancestors: string[][] = [];
  const seen = new Set<string>();
  for (const leaf of leaves) {
    for (let depth = 1; depth < leaf.path.length; depth += 1) {
      const ancestor = leaf.path.slice(0, depth);
      const key = JSON.stringify(ancestor);
      if (!seen.has(key)) {
        seen.add(key);
        ancestors.push(ancestor);
      }
    }
  }

  ancestors.sort((a, b) => a.length - b.length);

  let expression = `COALESCE(${column}, '{}'::jsonb)`;

  ancestors.forEach((ancestor, index) => {
    const pathParam = `${prefix}Ancestor${index}Path`;
    parameters[pathParam] = ancestor;
    // Read the current container off the column (not off `expression`) so the
    // expression stays linear in size; later `jsonb_set` calls only add keys.
    expression =
      `jsonb_set(${expression}, :${pathParam}::text[], ` +
      `CASE WHEN jsonb_typeof(${column} #> :${pathParam}::text[]) = 'object' ` +
      `THEN ${column} #> :${pathParam}::text[] ELSE '{}'::jsonb END, true)`;
  });

  leaves.forEach((leaf, index) => {
    const pathParam = `${prefix}${index}Path`;
    const valueParam = `${prefix}${index}Value`;
    parameters[pathParam] = leaf.path;
    parameters[valueParam] = JSON.stringify(leaf.value ?? null);
    expression = `jsonb_set(${expression}, :${pathParam}::text[], :${valueParam}::jsonb, true)`;
  });

  return { expression, parameters };
}
