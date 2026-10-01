/**
 * How a re-ingest folds what a source says NOW into the row it wrote before.
 *
 * `GraphIngestService` refreshes an existing entity when a source re-sends it,
 * and it used to do that by replacing `properties` wholesale. Every other writer
 * of that bag lost its keys on the next import:
 *
 *  - `PersonMergeService` folds each merged-away duplicate into the survivor,
 *    unioning its `emails` / `phones` / `names` / `Phones`. Re-importing the
 *    survivor's own contact card put back only what that card lists, so the
 *    numbers a merge brought in vanished — and with them the evidence behind
 *    any `ci.merge_candidates` row that cited one.
 *  - `is_self`, the structured-name keys a person edit writes (`first_name`,
 *    `last_name`, …), and whatever an enrichment pass recorded went the same way.
 *  - A later export of the same source replaced an earlier one's accumulated
 *    lists — the orders of a dish, a contact's URLs — instead of adding to them,
 *    though the parser had declared exactly those keys as sets.
 *
 * So the refresh is a merge, not a replace:
 *
 *  - a key the source does not send is left alone — it is someone else's;
 *  - a key it sends as JSON null says nothing and is skipped, the same "new
 *    value unless null" rule `bulkUpsert`'s other ingest refreshes follow;
 *  - a SET key (below) is unioned — what is stored, then what arrives that is
 *    new, blanks dropped, first-seen order kept;
 *  - any other key it sends takes the new value: the source's latest word on a
 *    fact it owns.
 *
 * The cost is deliberate: an import can no longer REMOVE a set member. A number
 * dropped from a card stays on the Person, as it already did in
 * `ci.entity_identifiers` (first writer wins, never deleted) and as the staging
 * layer's own `accumulate` contract promises within a run. Losing a merged-in
 * number silently is the worse failure.
 *
 * There are two implementations and they must agree. {@link mergeIngestedProperties}
 * is the definition, and what the service's staleness check runs.
 * {@link mergedPropertiesSql} is the same merge as SQL, so the write evaluates it
 * against the row as it stands when `ON CONFLICT` locks it — a merge that
 * committed after the service read the row is merged INTO, not overwritten. The
 * integration spec (`GraphIngestService.propertyMerge.integration.spec.ts`)
 * checks the two against each other on real Postgres.
 */

/**
 * The plural identity keys a Person carries, unioned on every re-ingest
 * whatever the source declared.
 *
 * This must cover every key `PersonMergeService`'s property fold unions, or a
 * re-import of the merge target undoes the merge for that key. It is also what
 * `GraphIngestService.rekeyImportedEntities` keeps of a row's standing merges
 * when it resets the row's properties, so the two can never disagree about
 * which values a merge brought in. Lowercase
 * `emails` / `phones` / `names` are the normalized handles `GraphIngestService`
 * indexes into `ci.entity_identifiers`; `Phones` is a contact card's numbers as
 * typed (the only place a number's country survives), and `Faxes` its fax
 * lines, filed apart so the phone adjudicator can refuse them.
 */
export const IDENTITY_LIST_KEYS: readonly string[] = ['emails', 'phones', 'names', 'Phones', 'Faxes'];

/**
 * Every key a re-ingest of this entity unions: the identity lists, then the
 * keys its parser declared as accumulating (`Entity.accumulate`, carried from
 * the staged row). Trimmed, blanks dropped, de-duplicated in order.
 */
export function unionKeysFor(accumulate?: readonly string[] | null): string[] {
  const keys: string[] = [];

  for (const key of [...IDENTITY_LIST_KEYS, ...(accumulate ?? [])]) {
    const trimmed = typeof key === 'string' ? key.trim() : '';

    if (trimmed !== '' && !keys.includes(trimmed)) {
      keys.push(trimmed);
    }
  }

  return keys;
}

/**
 * JSON with object keys in sorted order, so two payloads that differ only in key
 * order compare equal — the equality jsonb itself uses. A stored `properties`
 * value comes back from jsonb in Postgres' own key order, not the order the
 * source sent it.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};

      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }

      return sorted;
    }

    return v;
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** A set key's value as a list: a lone scalar is a list of one, absent is empty. */
function asList(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

/**
 * Stored members first, then the arriving ones not already present. Nulls and
 * empty strings are not members — the rule the staging layer's
 * `accumulatedValues` applies — and equality is jsonb's: objects by content
 * whatever their key order, `"1"` and `1` different.
 */
function unionList(stored: unknown, incoming: unknown): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();

  for (const entry of [...asList(stored), ...asList(incoming)]) {
    if (entry === null || entry === '') {
      continue;
    }

    const key = stableJson(entry);

    if (!seen.has(key)) {
      seen.add(key);
      out.push(entry);
    }
  }

  return out;
}

/**
 * The properties a re-ingest leaves on the row: `stored` with `incoming` merged
 * in by the rules in this module's header. Pure — `stored` is not modified.
 */
export function mergeIngestedProperties(
  stored: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown> | null | undefined,
  unionKeys: readonly string[],
): Record<string, unknown> {
  const held = isObject(stored) ? stored : {};
  const out: Record<string, unknown> = { ...held };

  if (!isObject(incoming)) {
    return out;
  }

  const sets = new Set(unionKeys);

  for (const [key, value] of Object.entries(incoming)) {
    if (value === null || value === undefined) {
      continue;
    }

    out[key] = sets.has(key) ? unionList(held[key], value) : value;
  }

  return out;
}

/**
 * {@link mergeIngestedProperties} as a SQL expression, for the SET list of an
 * `INSERT ... ON CONFLICT DO UPDATE`.
 *
 * @param existing the conflicting row's bag, e.g. `"entities"."properties"` —
 *   Postgres names the existing row by its unqualified table name there.
 * @param excluded the arriving bag, e.g. `EXCLUDED."properties"`.
 * @param unionKeys a SQL expression yielding the set keys as `text[]` — a bound
 *   parameter, so no key is ever spliced into the statement.
 *
 * Line for line: a non-object on either side counts as `{}`; incoming keys whose
 * value is JSON null are skipped; a set key's two sides are each read as a list
 * (a lone scalar is a list of one), members are de-duplicated by jsonb equality
 * keeping the earliest — stored before arriving, then by position — and nulls
 * and empty strings dropped; any other key takes the incoming value. Pure and
 * exported so the emitted SQL can be read without a driver.
 */
export function mergedPropertiesSql(existing: string, excluded: string, unionKeys: string): string {
  const held = `(CASE WHEN jsonb_typeof(${existing}) = 'object' THEN ${existing} ELSE '{}'::jsonb END)`;
  const arriving = `(CASE WHEN jsonb_typeof(${excluded}) = 'object' THEN ${excluded} ELSE '{}'::jsonb END)`;
  const asList = (value: string) =>
    `(CASE WHEN ${value} IS NULL THEN '[]'::jsonb ` +
    `WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ELSE jsonb_build_array(${value}) END)`;

  const union =
    `(SELECT COALESCE(jsonb_agg(kept.value ORDER BY kept.side, kept.position), '[]'::jsonb) ` +
    `FROM (SELECT DISTINCT ON (member.value) member.value, member.side, member.position ` +
    `FROM (SELECT prior.value, 0 AS side, prior.position ` +
    `FROM jsonb_array_elements(${asList(`${held} -> said.key`)}) WITH ORDINALITY AS prior(value, position) ` +
    `UNION ALL ` +
    `SELECT sent.value, 1 AS side, sent.position ` +
    `FROM jsonb_array_elements(${asList('said.value')}) WITH ORDINALITY AS sent(value, position)) AS member ` +
    `WHERE member.value NOT IN ('null'::jsonb, '""'::jsonb) ` +
    `ORDER BY member.value, member.side, member.position) AS kept)`;

  return (
    `${held} || COALESCE((` +
    `SELECT jsonb_object_agg(said.key, CASE WHEN said.key = ANY(${unionKeys}) THEN ${union} ELSE said.value END) ` +
    `FROM jsonb_each(${arriving}) AS said(key, value) ` +
    `WHERE jsonb_typeof(said.value) <> 'null'` +
    `), '{}'::jsonb)`
  );
}
