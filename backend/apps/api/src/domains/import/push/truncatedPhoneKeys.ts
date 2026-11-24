/**
 * What a contact's TRUNCATED phone key reached, undone once its row is back
 * under the card's own key.
 *
 * ## The rows this exists for
 *
 * The shared phone join key used to keep the last ten digits of line AND
 * extension, so an office line `(212) 555-0147;229` keyed as `5550147229` — a
 * well-formed number belonging to nobody on the card. `normalizeHandle` now
 * refuses such a value, and migration 20260930020117 repaired every row it
 * could PROVE held one: vCard Persons, whose `properties.Phones` kept the typed
 * value. Apple Contacts and CSV contact lists kept nothing but the truncation,
 * so their rows were left as they were: at `contact:5550147229`, holding the
 * fabricated `ci.entity_identifiers` phone, self claim, and whatever calls and
 * messages that number had been matched to.
 *
 * ## Who moves the row, and what is left for this module
 *
 * Moving the row is `push/legacyKeys.ts`'s job. Staging records the key the
 * card was minted under (`legacyEntityIdentityKey`, which reads handles with
 * the pre-fix `legacyNormalizeHandle`), and the push moves the row from there
 * onto the card's current key before ingest — the same move that separates
 * colleagues collapsed onto one office line, with the same guard on who
 * inherits a row.
 *
 * A move keeps the row's id, and with it everything the truncation reached. So
 * once the row sits under the card's key, this module undoes those — the
 * statements migration 20260930020117 ran for the vCard rows it could prove —
 * on the proof the card carries and the row could not:
 *
 *  1. the card was minted under a truncation: its staged `legacy_identity_key`
 *     is the old rule's reading of one of its own typed phones, a single line
 *     followed by an extension ({@link isLineWithExtension});
 *  2. the truncation is not also one of the card's real numbers: no typed
 *     value keys those digits under the current rule.
 *
 * What it removes, and from which rows, is the rule migration 20260930020117
 * and 20260930022046 agree on, so the three cannot disagree about one row:
 * only a live, unmerged Person that is no merge's survivor (a survivor's
 * digits may be a merged-in record's real number); an identifier row only
 * where its `raw_value` is NULL (a typed one was chosen by a person); the fake
 * taken out of `phones` / `phone` and nothing added in its place.
 *
 * It acts on the row at the card's CURRENT coordinate, not on "the row that
 * moved", so a push that died between the move and this repair finishes it on
 * the next attempt; and it touches only what the truncation itself reached —
 * a row with no trace of it is left as it is.
 */
import type { DataSource, EntityManager } from 'typeorm';

import { type GraphEntityInputDto, GraphIngestService, PHONE_EXTENSION_PATTERN } from '@ci/domains/graph';

import type { StagedEntity } from '../entities/StagedEntityEntity';
import { legacyNormalizeHandle, normalizeHandle } from '../staging/identity';

/**
 * Entity-metadata keys a contact parser keeps its identity handles under, AS
 * TYPED. vcard.ts, applecontacts.ts and contactlist.ts all write them.
 */
export const TYPED_HANDLE_KEYS = ['Phones', 'Emails'] as const;

/** The typed handle strings a metadata bag (or a row's `properties`) holds, in key order. */
export function typedHandlesOf(bag: Readonly<Record<string, unknown>> | null | undefined): string[] {
  const out: string[] = [];

  for (const key of TYPED_HANDLE_KEYS) {
    const value = bag?.[key];

    for (const entry of Array.isArray(value) ? value : [value]) {
      if (typeof entry === 'string' && entry.trim() !== '') {
        out.push(entry);
      }
    }
  }

  return out;
}

/**
 * The longest extension {@link isLineWithExtension} accepts: libphonenumber's
 * limit for an extension it is not sure of, and past what office extensions
 * run to.
 */
const MAX_EXTENSION_DIGITS = 6;

const PHONE_EXTENSION = new RegExp(PHONE_EXTENSION_PATTERN, 'i');

/**
 * `value` is ONE line (7–15 digits) followed by its extension — the only shape
 * whose last ten digits the old rule turned into a number nobody has.
 *
 * A value holding a second number after the extension is not a truncation at
 * all: Google's CSV joins a label's numbers into one cell, so
 * `(212) 555-0147;229 ::: +1 212-555-0199` keyed as `2125550199` — the card's
 * OWN second number. Dropping that identifier and withdrawing the links it made
 * would unlink real calls. So the digits after the marker must be an
 * extension's worth, and the digits before it one line's.
 */
function isLineWithExtension(value: string): boolean {
  const match = PHONE_EXTENSION.exec(value);

  if (match == null) {
    return false;
  }

  // The `x`/`ext` alternative opens by consuming the character before the
  // marker, and the `p`/`w` one the digit before it; neither belongs to the
  // extension.
  const start = /^[a-z;,#]/i.test(match[0]) ? match.index : match.index + 1;
  const line = value.slice(0, start).replace(/\D/g, '');
  const extension = value.slice(start).replace(/\D/g, '');

  return (
    line.length >= 7 && line.length <= 15 && extension.length >= 1 && extension.length <= MAX_EXTENSION_DIGITS
  );
}

/** Why a staged card's old key was a truncation. */
export interface TruncatedPhoneKey {
  /** The handle the card was minted under: the last ten digits of line + extension. */
  truncatedHandle: string;
  /** The card's current handle — its staged identity key — or null when it keys on its name. */
  handle: string | null;
  /** The typed values on the card that truncate to {@link truncatedHandle}. */
  typed: string[];
  /** Why, in words, the way `EntityTypeAuditService` files its evidence. */
  evidence: string[];
}

/**
 * The proof (see the module doc) for one staged entity, or null when its old
 * key was not a truncation of its own — including every row staged before
 * `legacy_identity_key` existed, which carries none.
 */
export function truncatedPhoneKeyFor(
  staged: Pick<StagedEntity, 'identityKey' | 'legacyIdentityKey' | 'metadata'>,
): TruncatedPhoneKey | null {
  const truncatedHandle = staged.legacyIdentityKey?.trim();
  const handle = staged.identityKey?.trim() || null;

  if (!truncatedHandle || truncatedHandle === handle) {
    return null;
  }

  const typed = typedHandlesOf(staged.metadata);
  const lines = typed.filter(
    (value) =>
      !value.includes('@') && isLineWithExtension(value) && legacyNormalizeHandle(value) === truncatedHandle,
  );

  // A card that also lists those ten digits as a plain number really has them:
  // the migration's "second half", and the row's identifier for them is real.
  if (lines.length === 0 || typed.some((value) => normalizeHandle(value) === truncatedHandle)) {
    return null;
  }

  return {
    truncatedHandle,
    handle,
    typed: lines,
    evidence: [
      `typed phone ${lines.join(', ')} carries an extension; the pre-fix rule keyed the card as ${truncatedHandle}`,
      `no typed value keys ${truncatedHandle} under the current rule, so no number on the card is those digits`,
      `the card keys as ${handle ?? 'its name'} now`,
    ],
  };
}

// ---------------------------------------------------------------------------
// The database half
// ---------------------------------------------------------------------------

/** One card whose old key was a truncation, and where its row sits now. */
export interface TruncatedPhoneRepair {
  /** The coordinate the push resolves the card under — its row's, once any move is done. */
  input: Pick<GraphEntityInputDto, 'key' | 'entityType' | 'sourceSystem'>;
  /** The staged row's `type` and `data_source`, for the still-claimed check. */
  stagedType: string | null;
  dataSource: string | null;
  proof: TruncatedPhoneKey;
}

/** Why a card's row was left as it is. */
export type TruncatedPhoneRepairSkip =
  /** No row sits under the card's current key yet: the card was never imported, or its old row stayed put. */
  | 'absent'
  /** A staged card in this run keys onto those ten digits for real, so what they reached may be real. */
  | 'still_claimed'
  /** A merge tombstone, a survivor, or an inactive row — outside the agreed rule. */
  | 'not_live';

export interface TruncatedPhoneRepairResult {
  /** Live rows the repair acted on. */
  repaired: string[];
  skipped: Record<TruncatedPhoneRepairSkip, number>;
  /** Rows whose name or `phones` / `phone` still carried the truncation. */
  rewritten: number;
  identifiersDeleted: number;
  selfClaimsDeleted: number;
  linksWithdrawn: number;
  edgesDeleted: number;
  freedIdentifiersIndexed: number;
}

/** `ci.entity_identifiers.source` for a number {@link repairTruncatedPhoneKeys} freed and re-indexed. */
export const TRUNCATED_PHONE_REKEY_SOURCE = 'import:truncated_phone_rekey';

function emptyResult(): TruncatedPhoneRepairResult {
  return {
    repaired: [],
    skipped: { absent: 0, still_claimed: 0, not_live: 0 },
    rewritten: 0,
    identifiersDeleted: 0,
    selfClaimsDeleted: 0,
    linksWithdrawn: 0,
    edgesDeleted: 0,
    freedIdentifiersIndexed: 0,
  };
}

interface ProbeRow {
  candidate: number;
  entity_id: string;
  is_live: boolean;
  still_claimed: boolean;
}

/**
 * The row under each card's current key. Locked, in one order for every push,
 * so what the repair acts on stays as found until commit and two runs of one
 * source cannot deadlock on it.
 */
const PROBE = `
  WITH c AS (
    SELECT *
      FROM jsonb_to_recordset($3::jsonb) AS c(
             candidate int, entity_type text, linked_table text, data_source text, staged_type text,
             linked_id uuid, old_key text)
  )
  SELECT c.candidate,
         e.entity_id,
         -- The agreed rule's rows: live, unmerged, and no merge's survivor.
         (COALESCE(e.is_active, true)
          AND e.merged_into_entity_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM ci.entities s WHERE s.merged_into_entity_id = e.entity_id)) AS is_live,
         -- The current rule still keys some card in this run on those ten
         -- digits: one whose real number they are, or that is named them. Every
         -- push status, so a resumed push that already sent it still sees it.
         EXISTS (SELECT 1
                   FROM ci_import.staged_entities s
                  WHERE s.run_id = $2::uuid
                    AND s.data_source IS NOT DISTINCT FROM c.data_source
                    AND s.type IS NOT DISTINCT FROM c.staged_type
                    AND (s.identity_key = c.old_key
                         OR (s.identity_key IS NULL AND lower(btrim(s.name)) = c.old_key))) AS still_claimed
    FROM c
    JOIN ci.entities e
      ON e.owner_user_id = $1::uuid
     AND e.entity_type = c.entity_type
     AND e.linked_table = c.linked_table
     AND e.linked_id = c.linked_id
   ORDER BY e.entity_id
     FOR UPDATE OF e`;

/** Rows the repair acts on. Mirrors migration 20260930020117's `_ext_card`. */
const CREATE_WORKING_SET = `
  CREATE TEMP TABLE _tpr ON COMMIT DROP AS
  SELECT t.entity_id, t.owner_user_id, t.old_key, e.name = t.old_key AS named_for_it
    FROM jsonb_to_recordset($1::jsonb) AS t(entity_id uuid, owner_user_id uuid, old_key text)
    JOIN ci.entities e ON e.entity_id = t.entity_id`;

/**
 * The repair: migration 20260930020117's statements for its population A,
 * each written against `_tpr` where the migration reads `_ext_card`, and
 * wrapped so it reports a count rather than TypeORM's `[rows, affected]` pair.
 * Its population B (identifier rows whose own typed value carries an
 * extension) is the migration's alone: nothing indexes such a value any more.
 */
const REPAIR = {
  changedTable: `CREATE TEMP TABLE _tpr_changed (entity_id uuid PRIMARY KEY) ON COMMIT DROP`,

  // (A1) The record: the fake leaves `phones`; `phone` falls back to the first
  // number left, or goes; a row named for its fake loses the name. Nothing is
  // added. Only a row this changes is written — and remembered, for the search
  // index and ledger reset at the end.
  properties: `
    WITH target AS (
      SELECT e.entity_id,
             p.phones,
             CASE WHEN t.named_for_it THEN NULL ELSE e.name END AS new_name,
             CASE
               WHEN NOT e.properties ? 'phone' OR e.properties ->> 'phone' <> t.old_key THEN e.properties -> 'phone'
               ELSE p.phones -> 0
             END AS phone
        FROM _tpr t
        JOIN ci.entities e ON e.entity_id = t.entity_id
        CROSS JOIN LATERAL (
          SELECT COALESCE(jsonb_agg(a.el ORDER BY a.ord), '[]'::jsonb) AS phones
            FROM jsonb_array_elements(CASE jsonb_typeof(e.properties -> 'phones')
                                        WHEN 'array'  THEN e.properties -> 'phones'
                                        WHEN 'string' THEN jsonb_build_array(e.properties -> 'phones')
                                        ELSE '[]'::jsonb
                                      END) WITH ORDINALITY AS a(el, ord)
           WHERE NOT (jsonb_typeof(a.el) = 'string' AND a.el #>> '{}' = t.old_key)
        ) p
    ),
    rebuilt AS (
      SELECT g.entity_id,
             g.new_name,
             (COALESCE(e.properties, '{}'::jsonb) - 'phones' - 'phone')
             || CASE WHEN e.properties ? 'phones' AND jsonb_array_length(g.phones) > 0
                     THEN jsonb_build_object('phones', g.phones) ELSE '{}'::jsonb END
             || CASE WHEN g.phone IS NOT NULL AND jsonb_typeof(g.phone) <> 'null'
                     THEN jsonb_build_object('phone', g.phone) ELSE '{}'::jsonb END AS new_properties
        FROM target g
        JOIN ci.entities e ON e.entity_id = g.entity_id
    ),
    changed AS (
      UPDATE ci.entities e
         SET properties = r.new_properties,
             name = r.new_name,
             updated_at = now()
        FROM rebuilt r
       WHERE e.entity_id = r.entity_id
         AND (e.properties IS DISTINCT FROM r.new_properties OR e.name IS DISTINCT FROM r.new_name)
      RETURNING e.entity_id
    )
    INSERT INTO _tpr_changed SELECT entity_id FROM changed`,

  countChanged: `SELECT count(*)::int AS n FROM _tpr_changed`,

  // (A2) The identifier with teeth — whatever its `source` or `verified_at`,
  // but only where its `raw_value` is NULL: the stored string WAS the key. A row
  // with a raw value was typed by a person, and a plain one stays theirs.
  identifiers: `
    WITH gone AS (
      DELETE FROM ci.entity_identifiers ei
       USING _tpr t
       WHERE ei.entity_id = t.entity_id
         AND ei.owner_user_id IS NOT DISTINCT FROM t.owner_user_id
         AND ei.kind = 'phone'
         AND ei.value_normalized = t.old_key
         AND ei.raw_value IS NULL
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM gone`,

  // `enrich.person_self_claim` upserts; only a retracting producer would remove
  // a claim the record stopped stating.
  selfClaims: `
    WITH gone AS (
      DELETE FROM ci.identifier_claims c
       USING _tpr t
       WHERE c.owner_user_id = t.owner_user_id
         AND c.subject_type = 'person'
         AND c.role = 'self'
         AND c.subject_id = t.entity_id
         AND c.kind = 'phone'
         AND c.value_normalized = t.old_key
         AND c.raw_value IS NULL
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM gone`,

  // Every (Person, key) proved fake that the Person no longer holds as an
  // identifier — computed from the proof, not from what was deleted, so the
  // links still come out when the migration took the identifier first; and a
  // key the Person still holds because a person typed it stays linked.
  withdrawn: `
    CREATE TEMP TABLE _tpr_withdrawn ON COMMIT DROP AS
    SELECT DISTINCT t.owner_user_id, t.entity_id, t.old_key
      FROM _tpr t
     WHERE NOT EXISTS (SELECT 1
                         FROM ci.entity_identifiers ei
                        WHERE ei.owner_user_id = t.owner_user_id
                          AND ei.entity_id = t.entity_id
                          AND ei.kind = 'phone'
                          AND ei.value_normalized = t.old_key)`,

  // One row per (subject, role, person) a withdrawn key linked, kept only when
  // no OTHER claim still links that person in that role — a different
  // identifier, or a human's confirmation of this one.
  links: `
    CREATE TEMP TABLE _tpr_links ON COMMIT DROP AS
    SELECT DISTINCT c.owner_user_id, c.subject_type, c.subject_id, c.role, c.entity_id
      FROM ci.identifier_claims c
      JOIN _tpr_withdrawn w
        ON w.owner_user_id = c.owner_user_id
       AND w.entity_id = c.entity_id
       AND w.old_key = c.value_normalized
     WHERE c.kind = 'phone'
       AND c.subject_type IN ('communication', 'event')
       AND c.disposition IS NULL
       AND NOT EXISTS (
             SELECT 1
               FROM ci.identifier_claims o
              WHERE o.owner_user_id = c.owner_user_id
                AND o.subject_type = c.subject_type
                AND o.subject_id = c.subject_id
                AND o.role = c.role
                AND o.entity_id = c.entity_id
                AND o.disposition IS DISTINCT FROM 'rejected'
                AND (o.disposition = 'confirmed'
                     OR NOT (o.kind = 'phone'
                             AND EXISTS (SELECT 1
                                           FROM _tpr_withdrawn w2
                                          WHERE w2.owner_user_id = o.owner_user_id
                                            AND w2.entity_id = o.entity_id
                                            AND w2.old_key = o.value_normalized))))`,

  countLinks: `SELECT count(*)::int AS n FROM _tpr_links`,

  communicationFrom: `
    UPDATE ci.communications c
       SET from_entity_id = NULL
      FROM _tpr_links l
     WHERE l.subject_type = 'communication'
       AND l.role = 'from'
       AND c.id = l.subject_id
       AND c.user_id = l.owner_user_id
       AND c.from_entity_id = l.entity_id`,

  // Per subject, not per link: an UPDATE ... FROM applies one joined row per
  // target, so two withdrawn recipients on one message must arrive together.
  communicationTo: `
    UPDATE ci.communications c
       SET to_entity_ids = ARRAY(SELECT u.id
                                   FROM unnest(c.to_entity_ids) WITH ORDINALITY AS u(id, ord)
                                  WHERE u.id <> ALL (g.ids)
                                  ORDER BY u.ord)
      FROM (
        SELECT owner_user_id, subject_id, array_agg(entity_id) AS ids
          FROM _tpr_links
         WHERE subject_type = 'communication' AND role = 'to'
         GROUP BY owner_user_id, subject_id
      ) g
     WHERE c.id = g.subject_id
       AND c.user_id = g.owner_user_id
       AND c.to_entity_ids && g.ids`,

  eventOrganizer: `
    UPDATE ci.events e
       SET organizer_entity_id = NULL,
           updated_at = now()
      FROM _tpr_links l
     WHERE l.subject_type = 'event'
       AND l.role = 'organizer'
       AND e.event_id = l.subject_id
       AND e.user_id = l.owner_user_id
       AND e.organizer_entity_id = l.entity_id`,

  eventParticipants: `
    UPDATE ci.events e
       SET participant_entity_ids = ARRAY(SELECT u.id
                                            FROM unnest(e.participant_entity_ids) WITH ORDINALITY AS u(id, ord)
                                           WHERE u.id <> ALL (g.ids)
                                           ORDER BY u.ord),
           updated_at = now()
      FROM (
        SELECT owner_user_id, subject_id, array_agg(entity_id) AS ids
          FROM _tpr_links
         WHERE subject_type = 'event' AND role = 'participant'
         GROUP BY owner_user_id, subject_id
      ) g
     WHERE e.event_id = g.subject_id
       AND e.user_id = g.owner_user_id
       AND e.participant_entity_ids && g.ids`,

  // The edges the promote legs projected from those columns, matched on the
  // rule that wrote each one — they only ever insert.
  edges: `
    WITH gone AS (
      DELETE FROM ci.relationships r
       USING _tpr_links l
       WHERE r.owner_user_id = l.owner_user_id
         AND r.from_entity_id = l.entity_id
         AND r.to_entity_id = l.subject_id
         AND r.properties ->> 'rule' = CASE
                                         WHEN l.subject_type = 'communication' AND l.role = 'from' THEN 'communication.sent'
                                         WHEN l.subject_type = 'communication' AND l.role = 'to' THEN 'communication.received'
                                         WHEN l.subject_type = 'event' AND l.role = 'organizer' THEN 'event.organized'
                                         WHEN l.subject_type = 'event' AND l.role = 'participant' THEN 'event.participated'
                                       END
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM gone`,

  // The claims resolve to nobody until `enrich.person_link` says otherwise.
  claims: `
    UPDATE ci.identifier_claims c
       SET entity_id = NULL,
           confidence = NULL,
           method = NULL
      FROM _tpr_withdrawn w
     WHERE c.owner_user_id = w.owner_user_id
       AND c.entity_id = w.entity_id
       AND c.value_normalized = w.old_key
       AND c.kind = 'phone'
       AND c.subject_type IN ('communication', 'event')
       AND c.disposition IS NULL`,

  // The number a withdrawn key freed, indexed for a Person whose own
  // `properties.phones` states it — `EntityIdentifierBackfillService`'s order,
  // oldest first. First writer wins, so the fake had kept it from them.
  freed: `
    WITH indexed AS (
      INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized, raw_value, source)
      SELECT DISTINCT ON (h.owner_user_id, h.phone_key)
             h.entity_id, h.owner_user_id, 'phone', h.phone_key, NULLIF(h.typed, h.phone_key), $1::text
        FROM (
          SELECT e.entity_id, e.owner_user_id, e.created_at, t.typed,
                 right(regexp_replace(t.typed, '\\D', '', 'g'), 10) AS phone_key
            FROM ci.entities e
            CROSS JOIN LATERAL jsonb_array_elements_text(
                         CASE jsonb_typeof(COALESCE(e.properties -> 'phones', e.properties -> 'phone'))
                           WHEN 'array'  THEN COALESCE(e.properties -> 'phones', e.properties -> 'phone')
                           WHEN 'string' THEN jsonb_build_array(COALESCE(e.properties -> 'phones', e.properties -> 'phone'))
                           ELSE '[]'::jsonb
                         END) AS t(typed)
           WHERE e.entity_type = 'Person'
             AND COALESCE(e.is_active, true) = true
             AND e.merged_into_entity_id IS NULL
             AND e.owner_user_id = $2::uuid
             AND NOT EXISTS (SELECT 1 FROM _tpr p WHERE p.entity_id = e.entity_id)
        ) h
        JOIN (SELECT DISTINCT owner_user_id, old_key FROM _tpr_withdrawn) w
          ON w.owner_user_id = h.owner_user_id
         AND w.old_key = h.phone_key
       -- The fixed rule's key only: a typed value with an extension keys nothing.
       WHERE h.typed !~* $3::text
       ORDER BY h.owner_user_id, h.phone_key, h.created_at, h.entity_id
      ON CONFLICT (owner_user_id, kind, value_normalized) DO NOTHING
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM indexed`,

  // `personSearchDocument` indexes the name and `properties.phone`, so a stored
  // vector answers to the fake until rewritten — and nothing rewrites a row that
  // has an embedding. The rows changed here, plus any whose vector still answers
  // to its fake (one the migration or the ingest already cleaned). The ledger
  // rows go too, re-opening every entity-keyed stage for them.
  vectorsStillFake: `
    INSERT INTO _tpr_changed
    SELECT DISTINCT t.entity_id
      FROM _tpr t
      JOIN ci_search.vectors vv ON vv.entity_id = t.entity_id
     WHERE vv.vector @@ to_tsquery('simple', t.old_key)
    ON CONFLICT (entity_id) DO NOTHING`,
  searchEmbeddings: `DELETE FROM ci_search.embeddings em USING _tpr_changed c WHERE em.entity_id = c.entity_id`,
  searchVectors: `DELETE FROM ci_search.vectors vv USING _tpr_changed c WHERE vv.entity_id = c.entity_id`,
  searchSkips: `DELETE FROM ci_search.index_skips sk USING _tpr_changed c WHERE sk.entity_id = c.entity_id`,
  ledger: `DELETE FROM ci.pipeline_state ps USING _tpr_changed c WHERE ps.entity_id = c.entity_id`,
} as const;

async function count(manager: EntityManager, sql: string, params: unknown[] = []): Promise<number> {
  const rows = (await manager.query(sql, params)) as Array<{ n: number }>;

  return Number(rows[0]?.n ?? 0);
}

/**
 * Undo, on the row under each card's current key, what the card's truncated
 * key reached — migration 20260930020117's statements, for the rows it could
 * not prove. One transaction. Run after the legacy-key moves and before the
 * ingest that refreshes those rows.
 *
 * Idempotent: every statement is scoped to the truncation, so once it is gone
 * from a row a second run changes nothing.
 */
export async function repairTruncatedPhoneKeys(
  dataSource: Pick<DataSource, 'transaction'>,
  scope: { userId: string; runId: string },
  repairs: readonly TruncatedPhoneRepair[],
): Promise<TruncatedPhoneRepairResult> {
  const result = emptyResult();

  if (repairs.length === 0) {
    return result;
  }

  const probe = repairs.map((repair, index) => ({
    candidate: index,
    entity_type: repair.input.entityType,
    linked_table: `import:${repair.input.sourceSystem}`,
    data_source: repair.dataSource,
    staged_type: repair.stagedType,
    linked_id: GraphIngestService.linkedIdFor(repair.input.key),
    old_key: repair.proof.truncatedHandle,
  }));

  return dataSource.transaction(async (manager) => {
    const found = (await manager.query(PROBE, [
      scope.userId,
      scope.runId,
      JSON.stringify(probe),
    ])) as ProbeRow[];
    const byCandidate = new Map(found.map((row) => [Number(row.candidate), row]));
    const working: Array<{ entity_id: string; owner_user_id: string; old_key: string }> = [];
    const seen = new Set<string>();

    repairs.forEach((repair, index) => {
      const row = byCandidate.get(index);

      if (row == null) {
        result.skipped.absent += 1;

        return;
      }

      if (row.still_claimed) {
        result.skipped.still_claimed += 1;

        return;
      }

      if (!row.is_live) {
        result.skipped.not_live += 1;

        return;
      }

      if (seen.has(row.entity_id)) {
        return;
      }

      seen.add(row.entity_id);
      working.push({
        entity_id: row.entity_id,
        owner_user_id: scope.userId,
        old_key: repair.proof.truncatedHandle,
      });
      result.repaired.push(row.entity_id);
    });

    if (working.length === 0) {
      return result;
    }

    await manager.query(CREATE_WORKING_SET, [JSON.stringify(working)]);
    await manager.query(REPAIR.changedTable);
    await manager.query(REPAIR.properties);
    result.rewritten = await count(manager, REPAIR.countChanged);
    result.identifiersDeleted = await count(manager, REPAIR.identifiers);
    result.selfClaimsDeleted = await count(manager, REPAIR.selfClaims);

    await manager.query(REPAIR.withdrawn);
    await manager.query(REPAIR.links);
    result.linksWithdrawn = await count(manager, REPAIR.countLinks);

    if (result.linksWithdrawn > 0) {
      await manager.query(REPAIR.communicationFrom);
      await manager.query(REPAIR.communicationTo);
      await manager.query(REPAIR.eventOrganizer);
      await manager.query(REPAIR.eventParticipants);
      result.edgesDeleted = await count(manager, REPAIR.edges);
    }

    await manager.query(REPAIR.claims);
    result.freedIdentifiersIndexed = await count(manager, REPAIR.freed, [
      TRUNCATED_PHONE_REKEY_SOURCE,
      scope.userId,
      PHONE_EXTENSION_PATTERN,
    ]);

    await manager.query(REPAIR.vectorsStillFake);
    await manager.query(REPAIR.searchEmbeddings);
    await manager.query(REPAIR.searchVectors);
    await manager.query(REPAIR.searchSkips);
    await manager.query(REPAIR.ledger);

    return result;
  });
}
