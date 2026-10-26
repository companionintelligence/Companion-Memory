/**
 * The data-quality check registry — `ci doctor`'s whole vocabulary.
 *
 * ## Why this exists
 *
 * Every check below was written first as a hand-typed SQL statement during a
 * live 13-source import of one person's real data, and every one of them found
 * something: communications with no thread, people named "Missed call from",
 * places named "IMG_0139.JPG", capture events with no thumbnail, 172 geocode
 * retries stuck past their next attempt. Those findings shipped as PRs
 * #2087–#2101, and the audit that found them lived in a scratch file that would
 * have been thrown away with the shell it was typed into.
 *
 * So these are REGRESSION DETECTORS, not hypotheticals. Each one is the
 * question "did the defect we just fixed come back?", asked in a form that both
 * a person and an agent can run: `ci doctor` for a table, `--json` for a
 * loop, and a non-zero exit when anything HIGH is non-zero so a loop can gate
 * on it.
 *
 * Run once against a live appliance an hour into that same import — 181,359
 * communications and 3,600 events written so far, twelve of thirteen sources
 * still pushing — the suite took 631ms and returned twelve findings, six of
 * them HIGH: 181,359 communications with no thread (all but four from
 * `google_voice`), 95,407 with no participant on either end, 10 capture events
 * with no content row, 472 pipeline retries past their next attempt, 55
 * unreplayed dead letters. None of that was visible from the import UI, which
 * showed every finished stage green.
 *
 * ## The mirroring rule
 *
 * Nearly every predicate here already exists somewhere else in the tree — as a
 * guard in `push/inputs.ts` that stops NEW rows being written, or as the WHERE
 * clause of the backfill migration that cleaned up the OLD ones. Where that is
 * true, this file MIRRORS it verbatim and the `mirrors` field says where from.
 * That is not decoration: a check that drifts from the guard it is supposed to
 * be watching silently stops watching it, and the only defence is that the two
 * are readable side by side. If you change a predicate here, change it there,
 * and vice versa.
 *
 * The mirrors are SQL-flavoured, so they are not character-identical to the
 * TypeScript ones. Two translation notes that have already bitten:
 *
 *   * Postgres regexes are POSIX AREs, not PCRE. `\y` is the word boundary;
 *     `\b` means a literal BACKSPACE and matches nothing you meant. `\d` and
 *     `\s` do work, but `[[:space:]]` / `[0-9]` are used where a migration
 *     already spelled it that way, so the two texts diff cleanly.
 *   * Every SQL string here is a `String.raw` template. A plain TS string would
 *     eat the backslashes — `'\FFFC'` is just `FFFC`, `'\.'` is just `.`, and
 *     `'\d'` is just `d` — turning a precise predicate into a much broader one
 *     that still runs and still returns a number. That is the worst possible
 *     failure mode for a check, so: raw, always.
 *
 * ## The statement contract
 *
 * ONE statement per check, returning EXACTLY ONE row, with these columns:
 *
 *   count      bigint  — offending rows. 0 means clean. Required.
 *   breakdown  jsonb   — optional `{key: n}` object; how the count splits by
 *                        the dimension that makes it diagnosable (usually
 *                        `source_system`, because "which importer did this?" is
 *                        the first question anyone asks).
 *   sample     jsonb   — optional one offending row, so a reader can see the
 *                        shape of the problem without writing a second query.
 *
 * One statement, and not one big union of fifty, for a reason learned the hard
 * way: a single CTE containing every check was tried during that session and
 * ONE slow arm took the entire audit down with it, after several minutes, with
 * nothing to show. Separate statements mean a slow check reports TIMEOUT and
 * the other eighteen still report their numbers. See {@link ImportDoctorService}
 * for the timeout mechanics.
 *
 * The `WITH bad AS (…) SELECT count(*), breakdown, sample FROM bad` shape is
 * deliberate too: `bad` is referenced three times, so Postgres materializes it
 * and the offending set is computed ONCE — count, breakdown and sample all read
 * the same scan rather than costing three.
 */

/**
 * How much a non-zero count matters.
 *
 * `high` is the gate: `ci doctor` exits non-zero when any high check is
 * non-zero, so it can sit in an agent's loop or a release check. Reserve it for
 * "this is provably wrong and there is a known fix" — a guard being violated, a
 * row that cannot be reached from anywhere, a job that will never run again.
 *
 * `medium` is "look at this, but it may be legitimate". The distinction is not
 * about how much a finding annoys you; it is about whether a machine can act on
 * it without a human deciding first. Future-dated events are the canonical
 * medium: three of them on the live appliance, all from `calendar`, all
 * correct, because a calendar is a list of things that have not happened yet.
 */
export type DoctorSeverity = 'high' | 'medium';

export interface DoctorCheck {
  /** Stable, kebab-case, never renamed — an agent's loop and a runbook both key on it. */
  id: string;
  severity: DoctorSeverity;
  /** One line, read as: what a NON-ZERO count means. Not what the check does. */
  title: string;
  /** The tables scanned. Printed next to a TIMEOUT so the reader knows what was slow. */
  scope: string;
  /**
   * What to do about a non-zero count — the sentence that turns a number into
   * an action. This is the field written FOR the agent: a fresh one with no
   * context should be able to read a finding and know where to go next.
   */
  remedy: string;
  /**
   * The guard or migration this predicate is a copy of, so the two stay
   * together. Null only where no such twin exists (the pipeline-health checks,
   * which watch a control plane rather than a data shape).
   */
  mirrors: string | null;
  /** One statement, one row, `count` / `breakdown` / `sample`. See the file header. */
  sql: string;
}

/**
 * A per-source count, as `{source_system: n}`.
 *
 * Factored out because eleven checks want the same thing and a typo in one copy
 * of it is invisible — the check still runs, still returns a count, and just
 * quietly reports its breakdown wrong. `COALESCE(…, '(null)')` because
 * `jsonb_object_agg` throws on a null key, and a null `source_system` is
 * exactly the kind of row a doctor should be able to report rather than crash
 * on.
 */
const breakdownBy = (column: string) =>
  `(SELECT jsonb_object_agg(k, n) FROM (SELECT COALESCE(${column}, '(null)') AS k, count(*) AS n FROM bad GROUP BY 1) g)`;

/** One offending row as jsonb, from the already-materialized `bad` set. */
const SAMPLE = `(SELECT to_jsonb(b) FROM bad b LIMIT 1)`;

/**
 * The checks, grouped in the order an import produces the data they inspect:
 * communications, then the people and places pulled out of them, then events
 * and content, then the enrichment control plane, then the search index.
 *
 * The doctor runs them in this order and reports in this order, which means the
 * output reads as a walk down the pipeline — useful when several checks fire at
 * once, because the earliest one is usually the cause and the rest the echo.
 */
export const DOCTOR_CHECKS: readonly DoctorCheck[] = [
  // ───────────────────────────────────────────────────────────────────────────
  // Communications
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'comms-missing-thread-id',
    // MEDIUM, not high: Apple's own chat.db holds messages with no
    // chat_message_join row and no 1:1 correspondent evidence (~37k of 432k on
    // the reference corpus). Those rows are honestly unthreadable, so this
    // count never reaches zero on a real iMessage corpus — and a high check
    // that can never reach zero would fail the doctor's gate forever on data
    // that is correct.
    severity: 'medium',
    title: 'Communications with no thread_id — the message exists but no conversation contains it',
    scope: 'ci.communications',
    remedy:
      'A message with no thread is unreachable from the thread view: it can only be found by search. ' +
      'The parsers now emit a thread key wherever the source provides one (imessage.ts and ' +
      'googlevoice.ts stamp ThreadId; `Conversation` joins the fallback chain in inputs.ts), and ' +
      'imessage.ts additionally threads a chat-less message onto its correspondent when that handle ' +
      'is a 1:1 chat identifier in the same database. Rows here predate those fixes, and importantly ' +
      'a re-import will NOT correct one: `thread_id` is not in INGEST_REFRESH_COLUMNS.communication, ' +
      'so re-ingesting a provenance triple that already exists leaves the stored value alone (that ' +
      'exclusion is deliberate — see the note there). Migrations 20260819000746 (from staged ChatId) ' +
      'and 20260819000941 (from 1:1 correspondent evidence) are the only repair for a row already in ' +
      'the database, and both read ci_import.staged_items, so they fill nothing once staging for that ' +
      'run is purged. The honest residue is iMessage rows with no chat_message_join entry AND no 1:1 ' +
      'correspondent evidence (37,181 of 432,173 on the reference corpus): they have no conversation ' +
      'to recover and stay NULL. If the breakdown names another source still writing NEW rows like ' +
      'this, its parser is not emitting a thread key at all, which is a parser fix.',
    mirrors: 'src/domains/import/push/inputs.ts toCommunicationInput (the thread-key chain)',
    sql: String.raw`
      WITH bad AS (
        SELECT id, time, source_system, communication_type
          FROM ci.communications
         WHERE thread_id IS NULL
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy('source_system')} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },
  {
    id: 'comms-missing-participants',
    severity: 'high',
    title: 'Communications with neither a sender nor a recipient — a message from nobody to nobody',
    scope: 'ci.communications',
    remedy:
      'These rows cannot be attributed to a person, so they are invisible to every people-centric view ' +
      'and contribute nothing to entity resolution. The participant edges are filled by the ' +
      '`extract_people` / `link_communications` enrichment legs — run ' +
      '`ci backfill extract_people link_communications` before concluding the parser is at fault. ' +
      'That backfill resolves handles out of `participants_metadata`, so it can only help a row that ' +
      'HAS one: a row whose participants_metadata is empty names nobody to resolve, and no leg will ' +
      'ever fill it. On the reference corpus that is 16,325 outbound iMessages whose chat.db row has ' +
      'neither recipients nor a partner handle (see migration 20260819000941) — the counterpart is ' +
      'genuinely unrecorded, and a name invented from a filename is the defect migration ' +
      '20260818220731 exists to undo. Note also what a re-import does NOT do here: from_entity_id and ' +
      'to_entity_ids are absent from INGEST_REFRESH_COLUMNS.communication (deliberately — they are ' +
      'resolved server-side), so re-ingesting an existing triple leaves them as they are. The parser ' +
      'fixes that stage participant edges (imessage.ts outbound fan-out, googlevoice.ts ' +
      'counterpartEdges) apply to rows written for the first time; migration 20260819000959 is the ' +
      'repair for rows already stored, and it too reads ci_import.staged_items. Agent chat turns ' +
      "(`POST /memory/turn`, category 'agent-turn') are not counted: they are the owner talking to an " +
      'agent, and there is no person on the other end to link.',
    mirrors: null,
    sql: String.raw`
      WITH bad AS (
        SELECT id, time, source_system, direction
          FROM ci.communications
         WHERE from_entity_id IS NULL
           AND (to_entity_ids IS NULL OR cardinality(to_entity_ids) = 0)
           -- An agent chat turn (MemoryController.turn, TURN_MESSAGE_CATEGORY)
           -- is the owner talking to an agent: no Person is on the other end,
           -- so an empty participant set is the honest value.
           AND category IS DISTINCT FROM 'agent-turn'
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy('source_system')} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },
  {
    id: 'comms-placeholder-content',
    severity: 'high',
    title: 'Message bodies that are nothing but a U+FFFC/U+FFFD placeholder glyph',
    scope: 'ci.communications',
    remedy:
      'macOS stores an attachment-only iMessage as a single U+FFFC OBJECT REPLACEMENT CHARACTER, and a ' +
      'mis-decoded byte run comes out as U+FFFD. Both used to be copied through verbatim, producing a ' +
      'row whose entire text is one invisible control glyph — 22,321 of them on a real appliance. ' +
      '`sanitizeText`/`isAttachmentPlaceholderOnly` in push/canonical.ts now strip it on the way in, ' +
      'so a non-zero count here means rows were written by a build predating that fix — re-import to ' +
      'heal them.',
    mirrors: 'src/domains/import/push/canonical.ts isAttachmentPlaceholderOnly',
    // Anchored (`^…$`), exactly as the write-time guard is: a captioned attachment
    // ("U+FFFC Merry Christmas") is a real message the user wrote and is NOT a
    // finding. The second predicate requires at least one actual glyph, so a
    // legitimately whitespace-only body is not counted either.
    sql: String.raw`
      WITH bad AS (
        SELECT id, time, source_system, length(content) AS content_length
          FROM ci.communications
         WHERE content ~ ('^[[:space:]' || U&'\FFFC' || U&'\FFFD' || ']+$')
           AND content ~ ('[' || U&'\FFFC' || U&'\FFFD' || ']')
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy('source_system')} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // People and places
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'position-not-a-place-name',
    severity: 'high',
    title:
      'ci.position.name holding a coordinate pair, a media filename, a bare UUID stem, a URI, or a title',
    scope: 'ci.position',
    remedy:
      'A fake place name is strictly worse than no place name: it renders in the Places view as though ' +
      'the place were already known, so nothing ever offers it a real one. NULL is the correct value — ' +
      'that is what makes the row a reverse-geocode candidate. `isNotAPlaceName` in push/inputs.ts ' +
      'blocks all four shapes at write time; rows written before the guard existed (64,917 of them on ' +
      'one real appliance) need a re-import.',
    mirrors: 'src/domains/import/push/inputs.ts isNotAPlaceName (+ geocode isUriLocation)',
    // All four arms of isNotAPlaceName, in its order: coordinate text (with the
    // optional generic geo-label prefix, so the bare and labelled forms are one
    // arm exactly as COORDINATE_TEXT makes them one regex), URI, media
    // extension, bare UUID stem. Every arm compares btrim(name), matching
    // isMediaFilename, which trims before testing — without it a name carrying
    // stray whitespace is rejected by the guard and missed here, and the two
    // would disagree about the same string.
    sql: String.raw`
      WITH bad AS (
        SELECT id, time, name, source_system
          FROM ci.position
         WHERE name IS NOT NULL
           AND (   btrim(name) ~* '\.(jpe?g|png|heic|heif|gif|mov|mp4|m4v|avi|webp|dng|tiff?)$'
                OR btrim(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}([-_][0-9]+)?$'
                OR btrim(name) ~* '^[a-z][a-z0-9+.-]*://\S+$'
                OR btrim(name) ~* '^[[:space:]]*((location|position|coordinates?|coords?|point|waypoint|fix|gps)[[:space:]]*[-:]?[[:space:]]*)?[-+]?[0-9]{1,3}(\.[0-9]+)?[[:space:]]*,[[:space:]]*[-+]?[0-9]{1,3}(\.[0-9]+)?[[:space:]]*$'
                -- A TITLE: prose, not a name. The fourth arm isNotAPlaceName
                -- grew (isTitleText) and this check did not, so it reported a
                -- clean bill of health for exactly the class that arm exists to
                -- reject — an Uber trip sentence, a clipped tweet body. Copied
                -- verbatim from NOT_A_PLACE_NAME_SQL in
                -- PositionPlacePromoteStage so the three mirrors read alike:
                -- U+2026 means the value is a PREFIX of longer text, !/?
                -- mean it is a sentence, and more than MAX_PLACE_NAME_WORDS (14)
                -- words is longer than any place name on this corpus. . and
                -- @ stay out of the punctuation arm: 'A.G. Bartlett Building'
                -- and 'On Jane Stanford Way @ Gilbert Biological Sciences' are
                -- real names, and each is a live ci.position.name.
                OR btrim(name) ~ '…$'
                OR btrim(name) ~ '[!?]'
                OR array_length(regexp_split_to_array(btrim(name), '\s+'), 1) > 14)
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy('source_system')} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },
  {
    id: 'person-name-garbage',
    severity: 'high',
    title: 'Person entities named with a call-log heading, an export filename, or a raw newline',
    scope: 'ci.entities',
    remedy:
      'These are not people. "Missed call from", "Group Conversation - 2019-…Z.html" and a name ' +
      "containing a literal newline are all the export's own chrome, promoted to a Person row because " +
      'the parser read a heading where a contact should have been. The current parsers write none of ' +
      'the three shapes, so rows here were written by a build predating those fixes — re-import from ' +
      'source to heal them.',
    mirrors: null,
    // Three arms: call-log headings, export filenames (plus "Group Conversation"
    // titles), and embedded newlines. `\y` is Postgres's
    // word boundary — POSIX ARE, not PCRE, so the JS `\b` spelling would match a
    // literal backspace and silently find nothing. Merged rows are excluded
    // because a merged-away row keeps its old name by design and is no longer
    // displayed anywhere.
    sql: String.raw`
      WITH bad AS (
        SELECT entity_id, name, linked_table, owner_user_id
          FROM ci.entities
         WHERE entity_type = 'Person'
           AND merged_into_entity_id IS NULL
           AND name IS NOT NULL
           AND (   name ~* '^[[:space:]]*(missed|placed|received|recorded|voicemail)([[:space:]]+call)?[[:space:]]+(from|to|with)\y'
                OR name ~* '(\.(html?|json|csv|vcf|txt)$)|(^[[:space:]]*group conversation\y)'
                OR name ~ '[\n\r]')
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy('linked_table')} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },
  {
    id: 'person-bare-phone-name',
    severity: 'medium',
    title: 'Person entities whose whole name is a phone number — an unresolved contact',
    scope: 'ci.entities',
    remedy:
      'MEDIUM on purpose, and the one check here that is not evidence of a bug. When an export names ' +
      'nobody, the handle IS the honest display name, and that is what gets written. What a non-zero ' +
      'count means is that these contacts have never been resolved to a named person, which is a merge ' +
      'opportunity: the last 10 digits of the name will often match the `phones` property of a named ' +
      'Person row. Treat a rising number as "the address book was never imported", not as corruption.',
    mirrors: null,
    sql: String.raw`
      WITH bad AS (
        SELECT entity_id, name, owner_user_id
          FROM ci.entities
         WHERE entity_type = 'Person'
           AND COALESCE(is_active, true) = true
           AND merged_into_entity_id IS NULL
           AND name ~ '^\+?[0-9()\-.\s]{7,}$'
      )
      SELECT count(*)::bigint AS count,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },
  {
    id: 'contact-cards-typed-as-concept',
    severity: 'high',
    title: 'Contact cards filed as Concept instead of Person — a human sitting in the graph as a thing',
    scope: 'ci.entities',
    remedy:
      'A contact card whose subject is not a Person. The cause is always the same: the parser typed the ' +
      'ITEM it emitted but not the ENTITY beside it, so `resolveEntityType` had only ' +
      '`hasContactIdentity` left to classify it — and a card carrying just a NAME has no phone or email ' +
      'for that to find, so it fell through to `type = null` and `entityTypeFor` mapped null to ' +
      "DEFAULT_ENTITY_TYPE = 'Concept'. Whether a card lists a phone number is not what decides whether " +
      'its subject is a human. Every known source is fixed forward — linkedin.ts, then vcard.ts, ' +
      'contactlist.ts and applecontacts.ts in f24110960 — but rows already written need a wipe and ' +
      're-import: the staged type is folded into `naturalKeyFor`, so the fixed parser keys the same ' +
      'card differently and a re-import over the old rows would mint a fresh Person beside the stale ' +
      'Concept rather than updating it. A NON-ZERO count on a source not named there means a FURTHER ' +
      "contact-shaped datasource is omitting `type` on its entity — set it to 'contact' at the parser. " +
      'The `breakdown` names the importer to go and look at.',
    mirrors: null,
    // Deliberately NOT scoped to the sources already fixed: this check watches
    // for the NEXT source to make the same mistake, so it recognises the SHAPE —
    // a handle-less contact card filed as a Concept by an importer — rather than
    // keying on a source list. A vcard-scoped check could not have caught vcard,
    // and could not have caught contactlist.ts or applecontacts.ts either.
    //
    // Recognising a contact card from its properties alone is the whole
    // difficulty, and it must be done WITHOUT a source list. What does NOT work
    // is `properties ? 'Source'`: every parser stamps it, so that predicate also
    // flags 20 Uber Eats dishes ("Seared Ahi Tuna Salad", "Horchata") which are
    // entirely legitimate Concepts. A HIGH check that can never reach zero is
    // worse than no check, so the discriminator is the contact-card metadata
    // vocabulary instead — keys only a parser reading a person's card emits.
    // Verified on the live corpus: this predicate returns 2,247 (every mis-typed
    // vCard row, nothing else) on the pre-fix data and 0 on a clean import.
    //
    // Handle-absence is the other half, and on the reference corpus it is exact:
    // 0 of the 2,249 mis-typed rows carried properties->'email' or ->'phone', and
    // 0 of the 1,335 correctly-typed cards lacked one. A Concept WITH a handle is
    // a different (and so far hypothetical) bug, left out rather than folded in.
    //
    // KNOWN BLIND SPOT, stated because a silent one is the failure mode this file
    // exists to prevent: the 2 mis-typed `contact_list` rows are invisible here.
    // Their parser stamped only {Source, File} when it wrote them, so nothing in
    // those rows' own data says "contact" — only a source-scoped sweep could catch
    // them, and this check cannot. (It now also keeps `Names` / `Emails` / `Phones`,
    // as does `applecontacts.ts`, so rows written since would be visible.) A
    // datasource whose contact entities carry no contact metadata at all is only
    // reachable by a source list, which is exactly what this check is built to
    // avoid needing.
    sql: String.raw`
      WITH bad AS (
        SELECT entity_id, name, linked_table, owner_user_id
          FROM ci.entities
         WHERE entity_type = 'Concept'
           AND linked_table LIKE 'import:%'
           AND merged_into_entity_id IS NULL
           AND properties ?| array['Names', 'Emails', 'Phones', 'Organizations',
                                   'JobTitles', 'Nicknames', 'SocialProfiles', 'Birthday']
           AND NOT (properties ? 'email' OR properties ? 'phone')
           AND name IS NOT NULL
           AND btrim(name) <> ''
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy('linked_table')} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },
  {
    id: 'person-duplicate-names',
    severity: 'medium',
    title: 'Person entities sitting in exact-duplicate name groups — the same human, several times',
    scope: 'ci.entities',
    remedy:
      'The count is ROWS in duplicate groups, not the number of groups: three "Chris Czaplak" rows ' +
      'count as three. Identical names are the cheapest possible duplicate signal and the one entity ' +
      'resolution should never miss, so a large number means the identifier-claim path did not run — ' +
      'try `ci backfill extract_people heal_self_collation`. It is MEDIUM because two different ' +
      'people really can share a name, so a machine must not merge on this alone.',
    mirrors: null,
    // Grouped on (owner_user_id, name) rather than name alone: two accounts on
    // one appliance each knowing a "John Smith" is not a duplicate, and merging
    // across owners would be a data leak, not a cleanup.
    sql: String.raw`
      WITH dupe AS (
        SELECT owner_user_id, name, count(*) AS n
          FROM ci.entities
         WHERE entity_type = 'Person'
           AND COALESCE(is_active, true) = true
           AND merged_into_entity_id IS NULL
           AND name IS NOT NULL
           AND btrim(name) <> ''
         GROUP BY 1, 2
        HAVING count(*) > 1
      )
      SELECT COALESCE(sum(n), 0)::bigint AS count,
             (SELECT to_jsonb(d) FROM (SELECT name, n AS rows FROM dupe ORDER BY n DESC, name LIMIT 1) d) AS sample
        FROM dupe
    `,
  },
  {
    id: 'contact-person-merges-several-people',
    severity: 'medium',
    title:
      'Imported Person rows whose card names are different people — colleagues collapsed onto one shared line',
    scope: 'ci.entities',
    remedy:
      'A contact import used to key each card on its smallest handle, and digits sort before letters, so ' +
      "every card from one office keyed on the switchboard (or the fax) and staged as ONE entity: the row's " +
      '`properties.Names` lists all of them, its Emails/Phones mix their details, and it feeds the ' +
      "duplicate detector every colleague's number. The parsers now pass over shared handles " +
      '(`markSharedContactHandles`). To repair a row, RE-IMPORT the same export: the push moves the row ' +
      'onto the new key of the colleague it is named after and rewrites it with that one card, and mints ' +
      'the others fresh (push/legacyKeys.ts). A row that survives a re-import was kept deliberately — no ' +
      'card claiming it bears its name — and needs a person to split it by hand; there is no unmerge. ' +
      'MEDIUM because a name is a poor identity: a typo in both parts of one person’s name reads as two people.',
    mirrors: 'src/domains/import/staging/identity.ts',
    // The SQL twin of `namesDescribeDifferentPeople`: two names are different
    // people when both carry a name element — a letter token of 2+ characters,
    // honorifics, suffixes and connectives aside — and no element of one equals,
    // or is a 3+ letter prefix of, an element of the other. A relation ("Tom's
    // mom") and a handle written into the name field are no evidence either way.
    //
    // Two translation notes. The TypeScript side folds accents with NFKD, which
    // Postgres cannot do without `unaccent` (not installed), so `translate`
    // folds the Latin accents a real address book carries; a name in another
    // script has no ASCII elements and, as in TypeScript, is no evidence. And it
    // strips honorifics/suffixes wherever they sit, where the tokenizer strips
    // them only at the ends, so a name using one as a middle name ("Md") can
    // read as different here and not there — close enough for a MEDIUM count,
    // which is all this is.
    //
    // `Names` is the accumulating key only vCard declares, so in practice this
    // watches `import:vcard`; applecontacts and contactlist declare none, and a
    // collapse there left no trace to count — the second person simply vanished.
    sql: String.raw`
      WITH names AS (
        SELECT e.entity_id, n.ord, n.value AS card_name
          FROM ci.entities e
          CROSS JOIN LATERAL jsonb_array_elements_text(e.properties->'Names') WITH ORDINALITY AS n(value, ord)
         WHERE e.entity_type = 'Person'
           AND e.linked_table LIKE 'import:%'
           AND e.merged_into_entity_id IS NULL
           AND jsonb_typeof(e.properties->'Names') = 'array'
           AND jsonb_array_length(e.properties->'Names') > 1
           AND n.value !~* '[''’]s(\s|$)'
           AND position('@' in n.value) = 0
      ),
      elements AS (
        SELECT DISTINCT names.entity_id, names.ord, t AS element
          FROM names,
               regexp_split_to_table(
                 translate(regexp_replace(lower(names.card_name), '[''’]', '', 'g'),
                           'àáâãäåāèéêëēìíîïīòóôõöøōùúûüūñçýÿ',
                           'aaaaaaaeeeeeiiiiiooooooouuuuuncyy'),
                 '[^a-z]+') AS t
         WHERE length(t) >= 2
           AND t NOT IN ('and', 'at', 'da', 'de', 'del', 'della', 'der', 'di', 'du', 'for', 'from',
                         'la', 'le', 'of', 'the', 'van', 'von',
                         'mr', 'mrs', 'ms', 'miss', 'mz', 'mx', 'dr', 'prof', 'professor', 'sir', 'madam',
                         'lady', 'lord', 'rev', 'reverend', 'hon', 'honorable', 'dame', 'fr', 'father', 'rabbi',
                         'jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md', 'esq', 'jd')
      ),
      named AS (
        SELECT DISTINCT entity_id, ord FROM elements
      ),
      collapsed AS (
        SELECT DISTINCT a.entity_id
          FROM named a
          JOIN named b ON b.entity_id = a.entity_id AND b.ord > a.ord
         WHERE NOT EXISTS (
                 SELECT 1
                   FROM elements x
                   JOIN elements y ON y.entity_id = x.entity_id
                  WHERE x.entity_id = a.entity_id
                    AND x.ord = a.ord
                    AND y.ord = b.ord
                    AND (x.element = y.element
                         OR (least(length(x.element), length(y.element)) >= 3
                             AND (left(x.element, length(y.element)) = y.element
                                  OR left(y.element, length(x.element)) = x.element))))
      ),
      bad AS (
        SELECT e.entity_id, e.name, e.linked_table, e.owner_user_id, e.properties->'Names' AS names
          FROM ci.entities e
          JOIN collapsed c USING (entity_id)
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy('linked_table')} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Events and content
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'events-location-without-name',
    severity: 'medium',
    title: 'Events whose metadata names a Location but whose location_name is NULL',
    scope: 'ci.events',
    remedy:
      'The source told us where this happened and the column that displays it is empty, so the event ' +
      'shows as placeless in the timeline and the map. Usually a mapping gap in the parser for the ' +
      'source named in the breakdown. Fix the mapping, then re-import — or run ' +
      '`ci backfill geocode` if the name is present but the coordinates are what is missing.',
    mirrors: 'src/domains/geocode/util/virtualLocations.ts isUriLocation (the exclusion)',
    // Two exclusions, and neither is incidental — both stop this check firing
    // on rows that are CORRECT.
    //
    // The URI arm: a calendar row whose location field held a meeting-join
    // link gets a NULL location_name on purpose, because a URL is not a place.
    // Those rows KEEP the URL in metadata.Location, so without this arm every
    // such calendar row would be reported as a defect by the check watching
    // for the opposite defect. Same grammar as isUriLocation
    // (geocode/util/virtualLocations.ts).
    //
    // The `[^[:space:]]` arm: `btrim(x)` strips SPACES ONLY, not tabs or
    // newlines, so an emptiness test written as `NULLIF(btrim(x), '')` reads a
    // Location of "\n\n" as present. That is not a hypothetical — the first
    // run of this check against a live appliance returned exactly one row, and
    // it was a `calendar` event whose Location was two newlines. Requiring at
    // least one non-whitespace character is the test that was actually meant.
    sql: String.raw`
      WITH bad AS (
        SELECT event_id, start_time, source_system,
               left(btrim(metadata ->> 'Location'), 120) AS location
          FROM ci.events
         WHERE location_name IS NULL
           AND metadata ->> 'Location' ~ '[^[:space:]]'
           AND btrim(metadata ->> 'Location') !~* '^[a-z][a-z0-9+.-]*://\S+$'
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy('source_system')} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },
  {
    id: 'capture-events-without-content',
    severity: 'high',
    title: 'Capture events pointing at a file but carrying no ci.content row — the blank-thumbnail class',
    scope: 'ci.events, ci.content',
    remedy:
      'A photo or video event links to its binary ONLY through ci.content (type=media, external_id = ' +
      'the ci.files id); there is no FK. No content row means no thumbnail anywhere in the UI, which is ' +
      'how this was found — 2,098 blank tiles in the gallery. `destinationsFor` was omitting the ' +
      "'content' destination for dated capture.* events (fixed in 8abfb5de5); rows written before that " +
      'fix need a re-import.',
    mirrors: 'src/domains/import/push/canonical.ts destinationsFor',
    // Requires metadata.FileId: a capture event
    // with no file reference has no binary to point at, so it is not a defect —
    // counting it would make this check fire forever on a corpus that has none.
    sql: String.raw`
      WITH bad AS (
        SELECT e.event_id, e.start_time, e.source_system, e.metadata ->> 'FileId' AS file_id
          FROM ci.events e
         WHERE e.category = 'capture'
           AND e.metadata ->> 'FileId' IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ci.content c WHERE c.event_id = e.event_id)
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy('source_system')} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },
  {
    id: 'blank-social-affiliation-content',
    severity: 'high',
    title: 'ci.content rows for a connection or a subreddit membership — an entry with no body at all',
    scope: 'ci.content',
    remedy:
      'A LinkedIn connection and a moderated subreddit carry no Text, no Body and no URL, so the ' +
      'content row toContentInput built for them has a NULL text AND a NULL url — and ci.content has ' +
      'no title column, so nothing about the row renders in any Content view. `destinationsFor` was ' +
      "sending every social.* record to 'content' as well as 'events' (fixed by isSocialAffiliation in " +
      'push/canonical.ts); rows already written are safe to delete. The facts are not lost ' +
      'either way: the connection is a ci.entities Person carrying the profile URL plus a dated ' +
      'social event, and the subreddit is an event titled r/<sub>.',
    mirrors: 'src/domains/import/push/canonical.ts isSocialAffiliation',
    // Provenance-scoped: this watches the ONE
    // shape the router now withholds, not blank content rows in general. Other
    // sources produce blank rows for their own reasons (vcard contact cards
    // with no note, Amazon app purchases) and folding them in here would make
    // this check permanently non-zero for causes it says nothing about.
    //
    // Emptiness is `!~ '[^[:space:]]'` and not `btrim(x) = ''` for the reason
    // the events-location-without-name check documents: btrim strips SPACES
    // ONLY, so the btrim form reads a body of two newlines as present.
    sql: String.raw`
      WITH bad AS (
        SELECT id, source_system, source_id, source_data ->> 'Kind' AS kind
          FROM ci.content
         WHERE source_type = 'ci-import-tools'
           AND (
                (source_system = 'linkedin' AND source_data ->> 'Kind' = 'connection')
             OR (
                  source_system = 'reddit'
                  AND source_data ->> 'Kind' IN ('moderated_subreddit', 'subscribed_subreddit')
                )
               )
           AND external_id IS NULL
           AND coalesce(text, '') !~ '[^[:space:]]'
           AND coalesce(url, '') !~ '[^[:space:]]'
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy('source_system')} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },
  {
    id: 'content-media-mimetype-mismatch',
    severity: 'medium',
    title: "ci.content typed 'media' whose mimetype is not an image, video, audio or watch-record type",
    scope: 'ci.content',
    remedy:
      "The type discriminator drives rendering: a row typed 'media' gets a player or a thumbnail, so an " +
      'ebook or an APK stamped media renders as a broken tile — Amazon Appstore rows ' +
      "('application/vnd.android.package-archive') belong typed 'app', not 'media'. Each mimetype in " +
      'the breakdown is a mapping the pushing parser got wrong — fix it at the source, then re-type ' +
      'the existing rows.',
    mirrors: 'src/domains/memory/services/contentFacetsSql.ts MEDIA_KINDS/OTHER_MEDIA_TYPE',
    // NULL mimetype is excluded deliberately: "media with no declared type" is a
    // weaker and much more common smell (most importers never set one), and
    // folding it in here would bury the actual mismatches under it.
    //
    // 'application/dash+xml' is excluded for the same reason, not because it is
    // rare: it is the WATCH_MEDIA_TYPE sentinel netflix.ts, hulu.ts,
    // disney_plus.ts, youtube.ts and _youtube_activity.ts all write, on purpose,
    // for a "you watched this" record that never had a downloaded file —
    // contentFacetsSql.ts's OTHER_MEDIA_TYPE bucket exists for exactly these
    // rows ("watch and listen records, documents") and the content grid renders
    // them from the tier-0 embed player, not from mimetype. On a full Drive
    // corpus this check found 68,533 such YouTube rows alongside 14 real
    // mismatches (Amazon ebooks/purchases) — the sentinel was burying the
    // signal 4,895 to 1.
    sql: String.raw`
      WITH bad AS (
        SELECT id, source_system, mimetype, left(external_id, 80) AS external_id
          FROM ci.content
         WHERE type = 'media'
           AND mimetype IS NOT NULL
           AND mimetype !~* '^(image|video|audio)/'
           AND mimetype <> 'application/dash+xml'
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy('mimetype')} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },
  {
    id: 'events-dated-before-1990',
    severity: 'high',
    title: 'Events dated before 1990 — a date no personal-data export legitimately carries',
    scope: 'ci.events',
    remedy:
      'Almost always an epoch-unit bug: seconds parsed as milliseconds lands in 1970, and a missing or ' +
      'zero timestamp lands there exactly. One such row anchors the whole timeline — every zoom-to-fit ' +
      'and every date histogram is computed over the range it defines. Find the parser named in the ' +
      'breakdown and check what it does with an absent timestamp.',
    mirrors: null,
    sql: String.raw`
      WITH bad AS (
        SELECT event_id, start_time, source_system, event_type
          FROM ci.events
         WHERE start_time < TIMESTAMPTZ '1990-01-01T00:00:00Z'
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy('source_system')} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },
  {
    id: 'events-dated-in-future',
    severity: 'medium',
    title: 'Events dated after now — legitimate for a calendar, a bug for everything else',
    scope: 'ci.events',
    remedy:
      'MEDIUM because the breakdown is the whole answer: a calendar is a list of things that have not ' +
      'happened yet, and three future-dated `calendar` rows on the live appliance are all correct. Any ' +
      'OTHER source in the breakdown is a defect — a photo, a purchase or a message cannot have ' +
      'happened tomorrow, and a far-future date is the other half of the epoch-unit bug that ' +
      'events-dated-before-1990 catches (milliseconds parsed as seconds lands in the year 56,000). ' +
      'Predicted and inferred events are excluded: forecasting the future is what they are for.',
    mirrors: null,
    sql: String.raw`
      WITH bad AS (
        SELECT event_id, start_time, source_system, event_type
          FROM ci.events
         WHERE start_time > now()
           AND COALESCE(is_predicted, false) = false
           AND COALESCE(is_inferred, false) = false
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy('source_system')} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },
  {
    id: 'events-timestamped-at-import',
    severity: 'high',
    title: 'Events wearing the import wall clock with no marker saying so',
    scope: 'ci.events',
    remedy:
      'A row whose start_time lands within two seconds of created_at — the shape of an import-wall-' +
      "clock fabrication — but carries no `time_source` saying so. `ci.events.time_source = 'ingest'` " +
      'is the declared marker every undated record is supposed to leave (push/inputs.ts toEventInput, ' +
      "from CanonicalRecord.dated; the column comment defines 'ingest' as \"stamped at import, i.e. not " +
      'a real date"). A row this suspiciously-timed and still unmarked means one of two things: a row ' +
      'imported BEFORE the fabricated-timestamp fix (repair it with 20260821084711, which marks on an ' +
      'exact join to ci_import.staged_items.occurred_at IS NULL), or a NEW producer that fabricates a ' +
      "date without going through toEventInput's guard — the real regression this check exists to catch. " +
      'Fix the parser, emit no date, and let the routing and the UI say "no date" instead of stamping one.',
    mirrors: 'db/postgres/migrations/20260809184710_clean_stage_support.sql (time_source vocabulary)',
    // `time_source = 'ingest'` is EXCLUDED here, not included: as of the
    // fabricated-timestamp fix that marker is the guard firing correctly, not
    // the guard being skipped — a handful of Google Maps saved places and
    // Reddit affiliations are *supposed* to carry it forever, and flagging
    // every one of them "high" every run is exactly the standing-defect-on-
    // correct-data failure this check used to have. What is still provably
    // wrong is the OTHER shape: no marker at all on a timestamp that looks
    // exactly like the import clock. `events-ingest-stamped-outside-known-
    // shapes` below is the companion check that watches the marked population
    // instead, at `medium`, because which shapes are legitimately undated is a
    // judgement call and this one is not. `time_source = 'source'` stays
    // excluded for the live-capture case: a capture genuinely ingested within
    // two seconds of the moment it records is legitimate, and the export said
    // so. Two seconds rather than one because a batch push writes created_at at
    // commit time, a beat after the row was built.
    sql: String.raw`
      WITH bad AS (
        SELECT event_id, start_time, created_at, source_system, time_source
          FROM ci.events
         WHERE created_at IS NOT NULL
           AND time_source IS DISTINCT FROM 'source'
           AND time_source IS DISTINCT FROM 'ingest'
           AND start_time BETWEEN created_at - INTERVAL '2 seconds' AND created_at + INTERVAL '2 seconds'
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy('source_system')} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },
  {
    id: 'events-ingest-stamped-outside-known-shapes',
    severity: 'medium',
    title: "Events marked time_source='ingest' for a (source, kind) nobody has declared undated",
    scope: 'ci.events',
    remedy:
      "Not a defect by itself — `time_source = 'ingest'` is the CORRECT mark for a record whose source " +
      'gave it no time (push/inputs.ts toEventInput). This check exists for the shapes nobody has looked ' +
      "at yet: it excludes the (source_system, metadata->>'Kind') pairs SOURCE_TIME_SPECS " +
      '(pipeline/stages/clean/TemporalRepairStage.ts) already declares as undatedKinds — ' +
      'google_maps_places/labeled_place and reddit/moderated_subreddit|subscribed_subreddit — so a hit ' +
      'is either a NEW legitimately-undated shape that belongs in that allowlist (add it, and this check ' +
      'goes quiet for it), or a regression: a kind that is supposed to carry a real source date ' +
      '(reddit/post, google_maps_places/place_review, …) losing it and falling back to the ingest clock. ' +
      'The breakdown is by source_system so "which importer did this?" is the first thing a reader sees; ' +
      "check the sample's `kind` against SOURCE_TIME_SPECS before deciding which of the two it is.",
    mirrors: 'src/domains/pipeline/stages/clean/TemporalRepairStage.ts (SOURCE_TIME_SPECS undatedKinds)',
    sql: String.raw`
      WITH bad AS (
        SELECT event_id, start_time, created_at, source_system, time_source,
               metadata ->> 'Kind' AS kind
          FROM ci.events
         WHERE time_source = 'ingest'
           AND NOT (
             (source_system = 'google_maps_places' AND metadata ->> 'Kind' = 'labeled_place')
             OR (source_system = 'reddit' AND metadata ->> 'Kind' IN ('moderated_subreddit', 'subscribed_subreddit'))
           )
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy('source_system')} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Enrichment control plane
  //
  // Not data shapes but WORK: rows the pipeline still owes, in states from which
  // nothing will pick them up again without a nudge. They are here because a
  // clean-looking corpus with a stalled control plane is the failure mode that
  // looks most like success.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'pipeline-overdue-retries',
    severity: 'high',
    title: 'Failed pipeline_state rows whose next_attempt_at is already in the past',
    scope: 'ci.pipeline_state',
    remedy:
      'The retry was scheduled and the moment passed with nothing claiming it — either no worker is ' +
      'running for that stage, or the whole backlog is larger than the tick can drain. 172 of these ' +
      'were sitting on `enrich.geocode` with reason `provider_unavailable` during the live import. ' +
      'Check the stage named in the breakdown has a running consumer, then re-drive it with ' +
      '`ci backfill <leg>`.',
    mirrors: null,
    // Cheap regardless of table size: 20260809032723 creates a partial index on
    // (status, next_attempt_at) WHERE status = 'failed', which is exactly this
    // predicate.
    sql: String.raw`
      WITH bad AS (
        SELECT entity_type, stage, entity_id, attempts, next_attempt_at, left(reason, 160) AS reason
          FROM ci.pipeline_state
         WHERE status = 'failed'
           AND next_attempt_at IS NOT NULL
           AND next_attempt_at < now()
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy('stage')} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },
  {
    id: 'pipeline-quarantined',
    severity: 'high',
    title: 'Quarantined pipeline_state rows — permanently excluded from claim(), silently',
    scope: 'ci.pipeline_state',
    remedy:
      'Quarantine is the state that makes a stage LOOK healthy while doing nothing: claim() skips these ' +
      'rows, so the job runs, reports green, and writes nothing. Replaying the dead letters does not ' +
      'clear it — the quarantine outlives them. Read `reason` first: it is the selector for the fix. ' +
      'Once the cause is dealt with, POST /api/pipeline/quarantine/release with {"reasons":[...]} sends ' +
      'exactly those rows back to the sweep with a full attempt budget — the alternative, bumping the ' +
      'stage version, re-opens the ENTIRE corpus, which on a metered stage is a bill. ' +
      'A pre-2026-08 appliance may show a large `provider_unavailable` or `ollama_unreachable` count ' +
      'here: those were a defect (a transient outage spent the quarantine budget in ~15 minutes) and ' +
      'migration 20260819054505 releases them on upgrade.',
    mirrors: null,
    sql: String.raw`
      WITH bad AS (
        SELECT entity_type, stage, entity_id, attempts, left(reason, 160) AS reason
          FROM ci.pipeline_state
         WHERE status = 'quarantined'
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy('stage')} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },
  {
    id: 'pipeline-dead-letters',
    severity: 'high',
    title: 'Dead letters never replayed — work the bus gave up on and nobody has looked at',
    scope: 'ci.pipeline_dead_letters',
    remedy:
      'Each row is one event the pipeline dropped, with the error that dropped it. These are the most ' +
      'information-dense rows in the whole appliance for working out what an import did wrong: during ' +
      'the live import eight of them said "Cannot find ffmpeg", which is a missing binary, not a data ' +
      'problem, and no other surface said so. Read the errors first, fix the cause, then replay.',
    mirrors: null,
    sql: String.raw`
      WITH bad AS (
        SELECT id, queue, event_name, stage, entity_type, failed_at, left(error, 160) AS error
          FROM ci.pipeline_dead_letters
         WHERE replayed_at IS NULL
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy('event_name')} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },
  {
    id: 'pipeline-orphan-shards',
    severity: 'medium',
    title: 'Shards left mid-flight under a run that finalised claiming it had nothing left to do',
    scope: 'ci.pipeline_shards, ci.pipeline_runs',
    remedy:
      'A bookkeeping contradiction, NOT lost data — and the difference is the point. A shard is a ' +
      'run-scoped lease and progress marker with a NULL cursor: the work itself lives in ' +
      '`ci.pipeline_state`, and the control tick re-derives the remainder from THE ONE RULE on every ' +
      'pass, so nothing here is unreachable and re-running the stage recovers nothing that was not ' +
      'already going to be swept. What a non-zero count means is that the run stamped `drained` ' +
      '("there is no work left") or `cancelled` while one of its own legs never reported, so the run ' +
      'progress view — the one place an operator looks to answer "is my import finished?" — disagrees ' +
      'with itself. Read `ci.pipeline_runs.detail` for the run named in the sample: a leg that left ' +
      '`detail.stages` mid-flight is the usual cause. Deleting the shards is safe and loses nothing.',
    mirrors: null,
    // Runs finalised `not_due` are EXCLUDED, and that exclusion is most of what
    // this check is. `PipelineControlService` finalises a run the moment nothing
    // is DUE even while legs still hold candidates — it has to, because
    // `pipeline_runs_active_uniq` allows one unfinished run per user and holding
    // one open for the six days until a weekly stage comes round would lock the
    // user out of ever pressing "reprocess" — and it deliberately leaves those
    // legs' shards untouched rather than saying `done` about them
    // (`markShardDrained` is skipped, `legsNotDue` is counted, the run is stamped
    // `finalizedReason: 'not_due'`). A pending shard under a `not_due` run is
    // therefore the control plane's INTENDED record of "this leg has work and it
    // is not its turn", which is why the un-narrowed predicate reported all
    // twelve legs of a healthy appliance as a defect. Same reasoning as
    // `events-missing-search-vector` excluding `index_skips`: a check reporting a
    // number that can never reach zero stops being read, and takes the checks
    // either side of it with it.
    //
    // Still keyed on `finished_at IS NOT NULL` rather than a run-status list,
    // following 20260809032723's own reasoning for its unique index: the status
    // vocabulary belongs to the runner and will grow, while "finished" is
    // structural. `finalizedReason` is read out of `detail` for the same reason —
    // it is what the finaliser writes — and compared with `IS DISTINCT FROM` so a
    // run finalised before that field existed, which has none, stays VISIBLE
    // instead of being silently exempted by a NULL.
    sql: String.raw`
      WITH bad AS (
        SELECT s.id, s.run_id, s.stage, s.shard_key, s.status, r.kind AS run_kind,
               r.status AS run_status, r.finished_at AS run_finished_at,
               r.detail->>'finalizedReason' AS finalized_reason
          FROM ci.pipeline_shards s
          JOIN ci.pipeline_runs r ON r.id = s.run_id
         WHERE s.status IN ('pending', 'running')
           AND r.finished_at IS NOT NULL
           AND r.detail->>'finalizedReason' IS DISTINCT FROM 'not_due'
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy('stage')} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Search index
  //
  // Both of these ask about ci_search.VECTORS, never ci_search.embeddings, and
  // that is load-bearing. The vector table is the search CANDIDATE source; the
  // embedding is only a re-ranking boost. A row with an embedding and no vector
  // is invisible to search while every coverage metric keyed on embeddings
  // reports it as done — which is exactly how a corpus can be "100% indexed"
  // and return nothing.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'events-missing-search-vector',
    severity: 'medium',
    title: 'Events with no ci_search.vectors row and no skip marker — unfindable by search',
    scope: 'ci.events, ci_search.vectors, ci_search.index_skips',
    remedy:
      'Run `ci backfill search_index`. If the number does not move, the listener is not writing ' +
      'vectors at all — check for quarantined pipeline_state rows and dead letters on the index stage ' +
      'first (this doctor has a check for each), because a quarantined row makes the backfill report ' +
      'success while writing nothing.',
    mirrors: null,
    // index_skips are DECIDED rows, not failures — a record with nothing worth
    // embedding. Excluding them is what keeps this check from permanently
    // reporting a number that can never reach zero.
    sql: String.raw`
      WITH bad AS (
        SELECT e.event_id, e.start_time, e.source_system
          FROM ci.events e
         WHERE NOT EXISTS (
                 SELECT 1 FROM ci_search.vectors v
                  WHERE v.entity_type = 'event' AND v.entity_id = e.event_id)
           AND NOT EXISTS (
                 SELECT 1 FROM ci_search.index_skips s
                  WHERE s.entity_type = 'event' AND s.entity_id = e.event_id)
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy('source_system')} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },
  {
    id: 'communications-missing-search-vector',
    severity: 'medium',
    title: 'Communications with no ci_search.vectors row and no skip marker — unfindable by search',
    scope: 'ci.communications, ci_search.vectors, ci_search.index_skips',
    remedy:
      'Same remedy as events-missing-search-vector, and usually the same cause. Separate checks because ' +
      'the two tables are indexed by different listeners and one can stall without the other: a run ' +
      'where events are covered and communications are not points straight at the communication ' +
      'listener rather than at the index as a whole.',
    mirrors: null,
    sql: String.raw`
      WITH bad AS (
        SELECT c.id, c.time, c.source_system
          FROM ci.communications c
         WHERE NOT EXISTS (
                 SELECT 1 FROM ci_search.vectors v
                  WHERE v.entity_type = 'communication' AND v.entity_id = c.id)
           AND NOT EXISTS (
                 SELECT 1 FROM ci_search.index_skips s
                  WHERE s.entity_type = 'communication' AND s.entity_id = c.id)
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy('source_system')} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Cross-pipeline identity (docs/design/cross-pipeline-identity.md)
  //
  // The identity indexes key on (user, source_system, source_id) so the same
  // datum delivered by a connection AND an archive lands once, and
  // ci.record_sources keeps one row per (record, arrival). These two checks
  // are the acceptance metric from §5 turned into a regression detector:
  // after a Takeout import and a connection sync of the same account, every
  // record inside the window both producers cover should carry two
  // arrivals. A record with one is either honest residue (a fallback-lane id,
  // counted separately) or a producer that stopped minting the shared key.
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'identity-fallback-lane-rows',
    // MEDIUM: the fallback lane is a DESIGNED outcome (design doc §3.5) —
    // Message-ID-less mail, UID-less VEVENTs, TZID-local RECURRENCE-IDs the
    // normalizer does not recognise. Those rows are correct and can never
    // converge, so the count is not zero on a correct corpus. What the
    // breakdown is for is the regression: a producer that used to key on the
    // natural key and now hashes instead (the exact-case `Message-ID` lookup
    // that dropped every `Message-Id:` message into this lane, 2026-09-01).
    severity: 'medium',
    title: 'Rows keyed on a fallback id — this datum will never converge with the other pipeline',
    scope: 'ci.communications, ci.events, ci.content, ci.browser_activity',
    remedy:
      'A `fallback:<sha256>` source_id means the producer could not find the datum’s natural key ' +
      '(the RFC Message-ID for mail, the iCalUID for a calendar event) and hashed pipeline-local ' +
      'material instead, which the OTHER pipeline cannot reproduce — so a copy delivered by the ' +
      'connection and a copy delivered by the archive stay two rows. Some of that is honest: mail ' +
      'with no Message-ID exists, and the design accepts the residue rather than pretend a body hash ' +
      'is stable. Read the breakdown per source_system against what the source can carry: `email` ' +
      'rows here should be rare, so a jump after a parser change means a builder stopped reading the ' +
      'header it used to (registry builders in src/domains/memory/identity/ return null for a missing ' +
      'key and the caller falls back; check the caller is passing the header at all). The rows ' +
      'themselves are not wrong and need no repair; the natural-key population converges on its own. ' +
      'Rows written before the identity change (no ledger arrival) are not fallback-lane and do not ' +
      'count here.',
    mirrors: 'src/domains/memory/identity/registry.ts fallbackId (the marker this predicate keys on)',
    sql: String.raw`
      WITH bad AS (
        SELECT 'communications' AS record_table, c.id, c.source_type, c.source_system, c.source_id
          FROM ci.communications c
         WHERE c.source_id LIKE 'fallback:%'
        UNION ALL
        SELECT 'events', e.event_id, e.source_type, e.source_system, e.source_id
          FROM ci.events e
         WHERE e.source_id LIKE 'fallback:%'
        UNION ALL
        SELECT 'content', k.id, k.source_type, k.source_system, k.source_id
          FROM ci.content k
         WHERE k.source_id LIKE 'fallback:%'
        UNION ALL
        SELECT 'browser_activity', b.id, b.source_type, b.source_system, b.source_id
          FROM ci.browser_activity b
         WHERE b.source_id LIKE 'fallback:%'
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy(`record_table || '/' || source_system`)} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },
  {
    id: 'identity-unconverged-in-overlap',
    // MEDIUM, and the floor is genuinely not zero: the connection sweeps the
    // mailbox the account has NOW, the archive holds what it had THEN, and a
    // message deleted between the two is honestly single-producer inside the
    // window. The number to watch is the trend across a re-import, not the
    // absolute — a step change after a parser change is the regression.
    severity: 'medium',
    title:
      'Records inside a two-producer overlap window that only one producer delivered — the pair did not converge',
    scope: 'ci.record_sources, ci.communications, ci.events, ci.browser_activity',
    // The second half of the key: `platform` is what tells a Gmail fetch
    // from an Outlook fetch once both ledger under the federated `email`.
    remedy:
      'For every (table, source_system, platform) a user has received from two producers (a connection sync and ' +
      'an import of the same account, say), this takes the window of record time BOTH producers cover ' +
      '(each producer’s 5th–95th percentile of record time, so a few stray old timestamps do not stretch it) ' +
      'and counts the records inside it that carry a single ci.record_sources arrival, excluding the ' +
      'fallback lane (identity-fallback-lane-rows counts that). Zero means every datum both producers ' +
      'delivered landed once — the acceptance metric in docs/design/cross-pipeline-identity.md §5. A ' +
      'non-zero count is one of three things, told apart by the breakdown key `table/system/producer`: ' +
      'honest residue (the archive holds mail the mailbox no longer does — expected, small, stable); a ' +
      'sub-population one side never fetches (the Gmail sync reads the inbox and sent sweeps while ' +
      'Takeout has every label — narrow the sync or accept it); or the two producers minting ' +
      'DIFFERENT keys for the same datum, which is the regression this exists for. For the third, ' +
      'pick one record from `sample`, find its twin in the other producer’s rows by subject and ' +
      'time, and compare the two source_ids: the conformance suite ' +
      '(src/domains/import/push/__tests__/crossPipelineIdentity.test.ts) is where the disagreement ' +
      'gets a fixture and the registry builder gets fixed. Rows that predate the ledger have no ' +
      'arrival and are outside this check entirely, and so is every arrival whose ledger platform is ' +
      'NULL — a generic mbox/eml or .ics import that could not name its mailbox pairs with nothing ' +
      '(record_sources.platform, migration 20260902225107); if a mailbox you DID connect shows no ' +
      'pair here, its importer is not stamping the platform the connection stamps.',
    mirrors:
      'src/domains/import/push/__tests__/crossPipelineIdentity.test.ts (the suite that defines "converges")',
    // Three UNION ALL arms rather than one join through a unioned view, so each
    // arm hits its own table's primary key; `first_seen` is the ARRIVAL time
    // and deliberately not used — the window is over the record's own time.
    //
    // Each producer's span is its 5th–95th percentile of record time, not its
    // min/max. Measured on the first post-wipe corpus: the Gmail connection
    // had synced ~870 messages, all but a handful from the last year, and the
    // handful (thread replays with 2014–2018 dates) stretched a min/max window
    // back a decade and pulled 11,100 archive-only messages into the count.
    // Trimming the tails keeps the window where the producer actually
    // delivered in bulk; a producer with fewer than 20 records has no interior
    // to trim and keeps its full span.
    sql: String.raw`
      WITH arrivals AS (
        SELECT rs.user_id, rs.record_table, rs.record_id, rs.source_system, rs.platform, rs.source_type,
               rs.source_id, c.time AS t
          FROM ci.record_sources rs
          JOIN ci.communications c ON rs.record_table = 'communications' AND c.id = rs.record_id
         WHERE rs.platform IS NOT NULL
        UNION ALL
        SELECT rs.user_id, rs.record_table, rs.record_id, rs.source_system, rs.platform, rs.source_type,
               rs.source_id, e.start_time
          FROM ci.record_sources rs
          JOIN ci.events e ON rs.record_table = 'events' AND e.event_id = rs.record_id
         WHERE rs.platform IS NOT NULL
        UNION ALL
        SELECT rs.user_id, rs.record_table, rs.record_id, rs.source_system, rs.platform, rs.source_type,
               rs.source_id, b.time
          FROM ci.record_sources rs
          JOIN ci.browser_activity b ON rs.record_table = 'browser_activity' AND b.id = rs.record_id
         WHERE rs.platform IS NOT NULL
      ),
      producers AS (
        SELECT user_id, record_table, source_system, platform, source_type,
               percentile_disc(0.05) WITHIN GROUP (ORDER BY t) AS lo,
               percentile_disc(0.95) WITHIN GROUP (ORDER BY t) AS hi
          FROM arrivals
         GROUP BY 1, 2, 3, 4, 5
      ),
      windows AS (
        SELECT user_id, record_table, source_system, platform, max(lo) AS lo, min(hi) AS hi
          FROM producers
         GROUP BY 1, 2, 3, 4
        HAVING count(*) >= 2 AND max(lo) <= min(hi)
      ),
      bad AS (
        SELECT a.record_table, a.record_id, a.source_system, a.platform,
               min(a.source_type) AS source_type, min(a.source_id) AS source_id, min(a.t) AS time
          FROM arrivals a
          JOIN windows w
            ON w.user_id = a.user_id AND w.record_table = a.record_table
           AND w.source_system = a.source_system AND w.platform = a.platform
         WHERE a.t BETWEEN w.lo AND w.hi
         GROUP BY 1, 2, 3, 4
        HAVING count(DISTINCT a.source_type) = 1
           AND bool_and(a.source_id NOT LIKE 'fallback:%')
      )
      SELECT count(*)::bigint AS count,
             ${breakdownBy(`record_table || '/' || platform || '/' || source_type`)} AS breakdown,
             ${SAMPLE} AS sample
        FROM bad
    `,
  },
];

/** Every check id, for validation and for `--list`. */
export const DOCTOR_CHECK_IDS: readonly string[] = DOCTOR_CHECKS.map((check) => check.id);

/** Look one up by id. Undefined for an id that does not exist. */
export function findCheck(id: string): DoctorCheck | undefined {
  return DOCTOR_CHECKS.find((check) => check.id === id);
}
