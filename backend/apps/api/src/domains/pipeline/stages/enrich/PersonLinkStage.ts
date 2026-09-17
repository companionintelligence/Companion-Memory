import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
// The graph domain's PUBLIC barrel, not its internals — `no-cross-domain-internals`
// allows exactly `index.ts` and `events.ts` across a domain boundary.
//
// These three are imported rather than re-implemented, and that is the single
// most important import in this file. `normalizeIdentifier`'s own header states
// the contract: it is "the single source of truth for the rule shared by the
// importer ... and the server", and "the two MUST stay byte-identical or the
// people-linking lookup silently misses". `ci.identifier_claims.value_normalized`
// and `ci.entity_identifiers.value_normalized` are the SAME key; a stage that
// normalised by its own rule would write claims nothing can ever join.
import { isNonNameParticipant, normalizeEmail, normalizeName, normalizePhone } from '@ci/domains/graph';

import { PIPELINE_QUEUES } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { STAGE_VERSIONS, type StageVersion } from '../../versions';
// Intra-domain, by path rather than through `../../index` —
// `no-intra-domain-via-barrel`. The same shape as `EstimateLocationStage`
// importing `FORWARD_GEOCODE_PROVIDER_GENERATION` from `GeocodeStage`.
//
// ONE E.164 derivation for the appliance. `clean.identifier_normalize` derives
// it to fill `ci.entity_identifiers`; this stage derives it to write a claim and
// to refuse a last-ten-digits collision. A second copy here would be the exact
// byte-duplication this phase exists to delete, and it would drift the moment
// either side gained a home region.
import { toE164 } from '../clean/IdentifierNormalizeStage';

/**
 * The two stage ids this file implements.
 *
 * ── Why TWO ids for one implementation ─────────────────────────────────────
 *
 * The plan calls for "one `PersonLinkStage` replacing three byte-duplicated
 * implementations", and that is exactly what this file is: one algorithm, one
 * normalisation rule, one claim writer, one projection rule, one version. But a
 * `Stage` declares exactly ONE `source` — one schema, one table, one id column —
 * because `PipelineStateService.selectStale` interpolates those four into the
 * sweep. `entityTypes` being a list does not multiply sources; it only lets one
 * table's rows be ledgered under different keys.
 *
 * The three services being replaced read TWO tables: `ci.communications`
 * (`PersonStubBackfillService`, `CommunicationLinkBackfillService`) and
 * `ci.events` (`EventParticipantBackfillService`). Two tables therefore need two
 * sweep entry points. The alternative — a `UNION ALL` view — was measured
 * against the shape of the sweep and rejected: `ORDER BY id LIMIT n` over a
 * union has no index to ride (neither table has a `(user_id, id)` btree), so
 * every hop would sort the user's whole corpus and the keyset would degrade to
 * exactly the O(corpus^2 / slice) behaviour `selectStale`'s anti-join comment
 * pins against.
 *
 * So: two ids, one `PersonLinkResolver`. Everything a version bump governs is
 * shared, so the two can never drift into disagreeing about what a person link
 * means.
 *
 * IDS ARE PERMANENT — the id is the third component of `ci.pipeline_state`'s
 * primary key, so renaming one abandons every ledger row written under the old
 * name: the sweep stops finding them and the whole corpus is re-linked under the
 * new id.
 */
export const ENRICH_PERSON_LINK_STAGE_ID = 'enrich.person_link';
export const ENRICH_EVENT_PERSON_LINK_STAGE_ID = 'enrich.event_person_link';

/** Ledger `entity_type`s, which double as `ci.identifier_claims.subject_type`. */
const COMMUNICATION_SUBJECT_TYPE = 'communication';
const EVENT_SUBJECT_TYPE = 'event';

// ---------------------------------------------------------------------------
// The versions, DERIVED rather than chosen
// ---------------------------------------------------------------------------

/**
 * Generation of the IDENTIFIER rule — how a raw participant string becomes a
 * `(kind, value_normalized, value_e164)` triple.
 *
 * Covers {@link classifyIdentifier}: the handle detection, the scheme stripping,
 * and the delegation to `normalizeEmail` / `normalizePhone` / `normalizeName`.
 * Bump it in the same commit that changes any of those — including the shared
 * rule in `domains/graph` — because a change makes every stored
 * `value_normalized` provisional. (Until CI-Import-Tools' retirement this also
 * meant bumping its copy of the rule; that repo's import functionality is now
 * native here.)
 */
export const IDENTIFIER_RULE_GENERATION = 1;

/**
 * Generation of the MATCH rule — which index row a triple resolves to, and how
 * sure that makes us.
 *
 * Covers {@link MATCH_CONFIDENCE}, the E.164 adjudication in
 * {@link adjudicate}, and the decision to resolve against
 * `ci.entity_identifiers` alone. Bump it when a number in that table moves or a
 * new method appears.
 */
export const PERSON_MATCH_RULE_GENERATION = 1;

/**
 * Generation of the PROJECTION rule — how resolved claims become the four link
 * columns.
 *
 * Deliberately its own term, and the reason `spec_version` and `stage_version`
 * are two numbers rather than one. Changing how links are projected (which roles
 * feed `to_entity_ids`, how ties break, whether a rejected claim is honoured)
 * must re-run the stage; it must NOT invalidate a single claim, because no claim
 * was produced by it. A shared integer could not express that, and would either
 * strand the projection or rewrite evidence that is still correct.
 */
// v2 — the plural projection MERGES into the column instead of replacing it.
// v1 wrote `to_entity_ids = <what this run resolved>`, so a message whose
// importer had already linked four recipients was cut down to the one name the
// index knew at sweep time (the owner's own, on every inbound group message of
// a fresh import — 106,382 rows on one appliance). The bump re-opens every row,
// which is also what re-links them now that their people exist.
export const PERSON_PROJECTION_RULE_GENERATION = 2;

/**
 * What lands in `ci.identifier_claims.spec_version` (and would land in
 * `ci.entity_identifiers.spec_version`): the generation of the rule that
 * produced the VALUE and the RESOLUTION.
 *
 * A SUM offset so both-at-1 gives 1, monotone in each term so it can only go UP
 * — the invariant `versions.ts` states, and the reason `EmbedStage` argues at
 * length against `version = hash(...)`.
 *
 * ── Why not `IDENTITY_SPEC_VERSION` ────────────────────────────────────────
 *
 * `domains/identity` was read for this and is NOT fit for purpose. It is the
 * OBJECT identity ladder — `canonicalizeUrl`, `buildNaturalKey`, content-hash
 * and provenance-triple rungs (`IdentityKind = 'src' | 'url' | 'sha256' | 'txt'
 * | 'nat'`) — answering "which content object is this row?", not "which person
 * does this email address belong to". The two share no input, no output and no
 * failure mode, and it has zero importers anywhere in the backend, so nothing
 * would even notice the coupling until it hurt. Tying them together would be
 * wrong in both directions: a change to URL canonicalisation would re-resolve
 * every phone number in the corpus, and widening phone normalisation would NOT
 * re-open a single object identity.
 *
 * What IS reused is its SHAPE, deliberately and to the letter: a declared
 * integer, persisted per row, so a recompute leg finds stale rows with
 * `WHERE spec_version < $current` — which is the sentence
 * `domains/identity/types.ts` uses to justify its own constant.
 */
export const PERSON_MATCH_SPEC_VERSION = IDENTIFIER_RULE_GENERATION + PERSON_MATCH_RULE_GENERATION - 1;

/**
 * The stage version both ids report — the spec plus the projection rule.
 *
 * A bump re-opens every row for re-linking, which is the fix for the defect
 * these three services share: `(from_entity_id IS NULL OR to_entity_ids IS NULL
 * OR cardinality(to_entity_ids) = 0)`. A message to five recipients where one
 * resolved today gets `to_entity_ids = [one]`, and that non-empty array
 * disqualifies the row FOREVER — the other four can never be linked, no matter
 * how many contacts arrive later. Nothing at the call site can fix that, because
 * the predicate that finds the work is the predicate that declares it done.
 */
export const PERSON_LINK_VERSION = PERSON_MATCH_SPEC_VERSION + PERSON_PROJECTION_RULE_GENERATION - 1;

/**
 * The version both stages report, cross-checked against `STAGE_VERSIONS`.
 *
 * `StageRegistry.assertConsistent` requires `stage.version` to equal
 * `STAGE_VERSIONS[id]`, because a hardcoded version would make bumping the
 * constant a silent no-op. A DERIVED version has the mirror-image failure: bump
 * a generation above, forget the diff to `versions.ts`, and the registry throws
 * at the first sweep with a message about hardcoding that is not what happened.
 *
 * So the derivation is the authority and the two `STAGE_VERSIONS` entries are its
 * reviewable mirrors. Both are checked, because the two ids share one derivation
 * and a bump that updated only one line would leave the pair silently describing
 * different amounts of history. A MISSING entry is not an error — this file is
 * imported by its own spec, and by `stageWiring.spec.ts`, independently of when
 * the central declarations land.
 *
 * `versions` is a parameter only so a test can prove the cross-check without
 * mutating the production declaration.
 */
export function personLinkStageVersion(versions: Record<string, StageVersion> = STAGE_VERSIONS): number {
  for (const stageId of [ENRICH_PERSON_LINK_STAGE_ID, ENRICH_EVENT_PERSON_LINK_STAGE_ID]) {
    const declared = versions[stageId];

    if (typeof declared === 'number' && declared !== PERSON_LINK_VERSION) {
      throw new Error(
        `STAGE_VERSIONS["${stageId}"] declares ${declared} but the stage derives ${PERSON_LINK_VERSION} ` +
          `from IDENTIFIER_RULE_GENERATION (${IDENTIFIER_RULE_GENERATION}) + PERSON_MATCH_RULE_GENERATION ` +
          `(${PERSON_MATCH_RULE_GENERATION}) + PERSON_PROJECTION_RULE_GENERATION ` +
          `(${PERSON_PROJECTION_RULE_GENERATION}) - 2. Bumping a generation is only half the change: ` +
          `update BOTH person-link entries in versions.ts in the same commit, or the two stages disagree ` +
          `about what has already been linked.`,
      );
    }
  }

  return PERSON_LINK_VERSION;
}

// Run at module load, not at first sweep — the same argument `StageRegistry`'s
// completeness guard makes. A generation bumped without the matching diff to
// `versions.ts` is a programming error, and the earliest possible failure is the
// cheapest one: at boot, on the operator's terminal, rather than inside a worker.
personLinkStageVersion();

// ---------------------------------------------------------------------------
// Confidence, graded by method
// ---------------------------------------------------------------------------

/**
 * How sure each matching rule makes us, in `(0, 1]`.
 *
 * **Explicit and graded, and never fabricated.** An exact email match is not a
 * display-name match, and writing one number for both is how a worse answer
 * permanently destroys a better one — the failure `StageResult.confidence`
 * names. Every number here is an argument about what the rule can and cannot
 * distinguish:
 *
 *  - `email_exact` (1.0) — a mailbox is globally unique and the match is on the
 *    whole of it. Nothing is inferred.
 *  - `phone_e164` (1.0) — both sides stated a country and the full international
 *    numbers are equal. As exact as an email.
 *  - `phone_last10` (0.85) — matched on the shared key, which is the last ten
 *    digits, because at least one side never stated a country. UK
 *    `+44 20 7946 0958` and US `(207) 946-0958` share those ten digits, so this
 *    is a real (if uncommon) collision and the number says so.
 *  - `handle_exact` (0.9) — a platform handle is unique ON its platform at a
 *    point in time, and the platform is part of the value. Below email only
 *    because handles are recycled: @alice on X in 2016 and in 2026 need not be
 *    the same person.
 *  - `name_exact` (0.6) — two people are called Alex Kim. This is the plan's
 *    number for a name-only match, and it exists so a display-name link is
 *    visibly weaker than every identifier link rather than indistinguishable
 *    from one.
 *
 * `phone_country_conflict` is deliberately absent: it is a REFUSAL, so it
 * resolves to no entity and carries no confidence at all.
 */
export const MATCH_CONFIDENCE = {
  email_exact: 1,
  phone_e164: 1,
  handle_exact: 0.9,
  phone_last10: 0.85,
  name_exact: 0.6,
} as const;

export type MatchMethod = keyof typeof MATCH_CONFIDENCE;

/** Recorded on a claim the E.164 check REFUSED. Resolves to nobody, by design. */
export const PHONE_COUNTRY_CONFLICT = 'phone_country_conflict';

// ---------------------------------------------------------------------------
// Identifier classification
// ---------------------------------------------------------------------------

/** What `ci.identifier_claims.kind` permits. */
export type ClaimKind = 'email' | 'phone' | 'handle' | 'name';

/** Which slot of the subject row an identifier sat in. */
export type ClaimRole = 'from' | 'to' | 'cc' | 'bcc' | 'organizer' | 'participant';

/** One normalised identifier, ready to be claimed and looked up. */
export interface ClaimedIdentifier {
  kind: ClaimKind;
  /** The SHARED join key. Byte-identical to what `ci.entity_identifiers` holds. */
  valueNormalized: string;
  /** Strict international phone form when the raw stated a country; else null. */
  valueE164: string | null;
  /** The source's own text, kept only when it differs from the key. */
  rawValue: string | null;
}

/** One identifier observed on one row, in one role. */
export interface ParticipantObservation {
  subjectId: string;
  role: ClaimRole;
  identifier: ClaimedIdentifier;
}

/**
 * URI schemes a source may wrap an identifier in. Stripped before classification
 * so `tel:+15555550100` is a phone rather than a name — vCard, Signal and iOS
 * exports all use them, and `classifyParticipant`'s phone-shape test rejects any
 * string containing a letter, so today every one of these lands as a display
 * name and never matches anything.
 */
const IDENTIFIER_SCHEME = /^(?:mailto|tel|sms|smsto|imessage|whatsapp|callto):/i;

/**
 * A platform-qualified social handle: `x:@alice`, `instagram:bob`,
 * `reddit:u_carol`.
 *
 * The value part excludes `@`, so `mailto:alice@example.com` cannot match and be
 * mistaken for a handle. The platform part allows a SINGLE character, because
 * the platform this matters most for renamed itself to `x`.
 */
const QUALIFIED_HANDLE = /^([a-z][a-z0-9_+-]{0,31}):@?([A-Za-z0-9._-]{1,64})$/i;

/** A bare handle: `@alice`. Qualified with the source platform when one is known. */
const BARE_HANDLE = /^@([A-Za-z0-9._-]{1,64})$/;

/**
 * Phone-shaped end-to-end: digits and common phone punctuation only.
 *
 * DUPLICATED in effect from `classifyParticipant`'s `PHONE_SHAPE_REGEX`, which
 * the graph barrel does not export. The rule is the same and must stay so: a
 * string that merely CONTAINS digits is not a phone, because chat handles
 * routinely embed digit runs ("alexmz12", "griffin5131") and the older version
 * of that check turned them into bogus two-digit phone numbers that collided
 * with each other.
 */
const PHONE_SHAPE = /^[+()\-.\s\d]+$/;

/** Shortest local subscriber number. Below this, an all-digit string is a name. */
const PHONE_MIN_DIGITS = 7;

/**
 * Classify and normalise one raw participant string.
 *
 * This is `classifyParticipant` WIDENED, in the two ways Phase 4 calls for, and
 * otherwise identical — the shared normalisers do all the actual work, so the
 * key it produces still joins `ci.entity_identifiers` byte-for-byte:
 *
 *  1. **`handle`.** `classifyParticipant` routes `@alice` to `kind='name'`, so
 *     an Instagram/X/Reddit identity lands in the same namespace as a human
 *     display name — two unrelated people who both go by "alex" collide with
 *     each other AND with the handle. A handle now gets its own kind, qualified
 *     by the platform when the source names one, so `x:@alice` and
 *     `instagram:@alice` stay apart.
 *  2. **E.164.** The shared key keeps the last ten digits and is left exactly as
 *     it was (it is a cross-repo join key); the strict international form rides
 *     alongside in `valueE164`, derived only when the raw value STATED a
 *     country. See {@link toE164} for why no default region is assumed.
 *
 * Returns `null` when nothing usable can be derived — an empty string, a lone
 * punctuation run — so the caller can count it rather than store an empty.
 *
 * @param platform source system hint (`ci.communications.source_system`), used
 * ONLY to qualify a bare `@handle`. Never invented and never applied to
 * anything else.
 */
export function classifyIdentifier(raw: string | null, platform?: string | null): ClaimedIdentifier | null {
  if (raw == null) {
    return null;
  }

  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return null;
  }

  // Same door as `classifyParticipant`'s, and for the same reason: this
  // function's LAST branch is `name`, so anything unrecognised becomes a claim
  // on a display name. A call-log heading, an export filename or a string
  // carrying a newline is a parser leak, not an identity, and a claim keyed on
  // one is a permanent wrong answer in `ci.identifier_claims`.
  if (isNonNameParticipant(trimmed, 'PersonLinkStage.classifyIdentifier')) {
    return null;
  }

  const unwrapped = trimmed.replace(IDENTIFIER_SCHEME, '').trim();

  if (unwrapped.length === 0) {
    return null;
  }

  // Handles FIRST. `x:@alice` contains no `@` at position 0 and would otherwise
  // be read as an email address at the `x:` mailbox.
  const handle = readHandle(unwrapped, platform);

  if (handle != null) {
    return claimed('handle', handle, null, trimmed);
  }

  if (unwrapped.includes('@')) {
    const value = normalizeEmail(unwrapped);

    return value == null ? null : claimed('email', value, null, trimmed);
  }

  if (isPhoneShaped(unwrapped)) {
    const value = normalizePhone(unwrapped);

    // `normalizePhone` returns null only when there are no digits at all, which
    // `isPhoneShaped` has already excluded — but the guard stays, because a
    // change to the shared rule must degrade to "unusable, counted" rather than
    // to a claim keyed on an empty string.
    return value == null ? null : claimed('phone', value, toE164(unwrapped), trimmed);
  }

  const value = normalizeName(unwrapped);

  return value == null ? null : claimed('name', value, null, trimmed);
}

function claimed(
  kind: ClaimKind,
  valueNormalized: string,
  valueE164: string | null,
  raw: string,
): ClaimedIdentifier {
  return {
    kind,
    valueNormalized,
    valueE164,
    // Provenance only when it adds something, exactly as
    // `EntityIdentifierService.upsertForEntities` decides it.
    rawValue: raw === valueNormalized ? null : raw,
  };
}

/**
 * The canonical form of a social handle, or `null` when the string is not one.
 *
 * `platform:@handle` when the platform is known — from the string itself, or
 * from the source system when the string is a bare `@handle`. A bare handle with
 * no platform stays bare rather than being stamped with a guessed one: an
 * unqualified handle is honestly ambiguous, and a fabricated qualifier would
 * merge two platforms' users.
 */
function readHandle(value: string, platform?: string | null): string | null {
  const qualified = QUALIFIED_HANDLE.exec(value);

  if (qualified != null) {
    return `${qualified[1].toLowerCase()}:@${qualified[2].toLowerCase()}`;
  }

  const bare = BARE_HANDLE.exec(value);

  if (bare == null) {
    return null;
  }

  const source = normalizePlatform(platform);

  return source == null ? `@${bare[1].toLowerCase()}` : `${source}:@${bare[1].toLowerCase()}`;
}

/** A source system reduced to a handle qualifier, or null when it is unusable. */
function normalizePlatform(platform: string | null | undefined): string | null {
  if (platform == null) {
    return null;
  }

  const cleaned = platform.toLowerCase().replace(/[^a-z0-9_]/g, '');

  return cleaned.length > 0 && cleaned.length <= 32 ? cleaned : null;
}

function isPhoneShaped(value: string): boolean {
  return PHONE_SHAPE.test(value) && value.replace(/\D/g, '').length >= PHONE_MIN_DIGITS;
}

// ---------------------------------------------------------------------------
// Reading participants off a source row
// ---------------------------------------------------------------------------

/** A slice row, as either descriptor's load projects it. */
export interface SubjectRow {
  id: string;
  /** `participants_metadata` for communications, `metadata` for events. */
  metadata: Record<string, unknown> | null;
  /** `source_system`, used only to qualify bare handles. */
  platform: string | null;
  /** Soft-delete flag. Always false for communications, which have no such column. */
  is_deleted: boolean | null;
}

/**
 * `{from, to, cc, bcc}` off a communication.
 *
 * `cc` and `bcc` are CLAIMED but not projected — see
 * {@link COMMUNICATION_SUBJECT}. `PersonStubBackfillService` already collected
 * them (to mint stub people) while `CommunicationLinkBackfillService` ignored
 * them entirely; keeping the observation and being explicit about the projection
 * is what makes that difference reviewable instead of accidental.
 */
export function readCommunicationObservations(row: SubjectRow): ParticipantObservation[] {
  const meta = row.metadata ?? {};
  const observations: ParticipantObservation[] = [];

  const collect = (role: ClaimRole, raw: string | null): void => {
    const identifier = classifyIdentifier(raw, row.platform);

    if (identifier != null) {
      observations.push({ subjectId: row.id, role, identifier });
    }
  };

  collect('from', readString(meta.from) ?? readString(meta.From));

  for (const [role, value] of [
    ['to', meta.to ?? meta.To],
    ['cc', meta.cc ?? meta.Cc ?? meta.CC],
    ['bcc', meta.bcc ?? meta.Bcc ?? meta.BCC],
  ] as const) {
    for (const raw of readIdentifierArray(value)) {
      collect(role, raw);
    }
  }

  return observations;
}

/**
 * Organizer + attendees off an event.
 *
 * The key list is `EventParticipantBackfillService`'s, unchanged, because the
 * importer flattens timeline items from many sources into `ci.events` with
 * varying shapes and that list is the accumulated knowledge of which. What is
 * NOT unchanged is what the values are allowed to be: that service's
 * `classifyEmail` drops anything without an `@`, so an attendee identified by a
 * phone number, a handle or a display name is invisible to it. Here every entry
 * goes through {@link classifyIdentifier}, so those become claims — unresolved
 * ones on a corpus with no matching contact, which is a countable number rather
 * than a silence.
 */
export function readEventObservations(row: SubjectRow): ParticipantObservation[] {
  const meta = row.metadata ?? {};
  const observations: ParticipantObservation[] = [];

  const collect = (role: ClaimRole, raw: string | null): void => {
    const identifier = classifyIdentifier(raw, row.platform);

    if (identifier != null) {
      observations.push({ subjectId: row.id, role, identifier });
    }
  };

  collect('organizer', readOrganizer(meta));

  for (const source of [
    meta.participants,
    meta.Participants,
    meta.attendees,
    meta.Attendees,
    meta.to,
    meta.To,
  ]) {
    for (const raw of readIdentifierArray(source)) {
      collect('participant', raw);
    }
  }

  return observations;
}

/**
 * A single organizer identifier. Order is priority: the cleanest, most specific
 * key wins, exactly as `EventParticipantBackfillService.readOrganizerEmail`
 * orders them.
 */
function readOrganizer(meta: Record<string, unknown>): string | null {
  const direct = readString(meta.organizerEmail) ?? readString(meta.organizer_email);

  if (direct != null) {
    return direct;
  }

  const nested = readIdentifierText(meta.organizer) ?? readIdentifierText(meta.Organizer);

  if (nested != null) {
    return nested;
  }

  return readString(meta.from) ?? readString(meta.From);
}

/** A non-empty string, or null. */
function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  return value.trim().length > 0 ? value : null;
}

/** Every identifier-bearing entry of an array-ish metadata value. */
function readIdentifierArray(value: unknown): string[] {
  if (typeof value === 'string') {
    const single = readString(value);

    return single == null ? [] : [single];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  const out: string[] = [];

  for (const item of value) {
    const text = readIdentifierText(item);

    if (text != null) {
      out.push(text);
    }
  }

  return out;
}

/**
 * Coerce one participant entry — a string, or an object — into the best
 * identifier text it carries.
 *
 * Email first (the Google `{email, name}` shape and the Outlook Graph
 * `{emailAddress: {address}}` one), then phone, then handle, then the DISPLAY
 * NAME. That last fallback is new: a Messenger or Instagram attendee has no
 * address at all, so today it contributes nothing and the row reads as having no
 * participants.
 */
function readIdentifierText(item: unknown): string | null {
  if (typeof item === 'string') {
    return readString(item);
  }

  if (item == null || typeof item !== 'object') {
    return null;
  }

  const obj = item as Record<string, unknown>;

  const direct =
    readString(obj.email) ?? readString(obj.Email) ?? readString(obj.address) ?? readString(obj.Address);

  if (direct != null) {
    return direct;
  }

  const nested = obj.emailAddress ?? obj.EmailAddress;

  if (nested != null && typeof nested === 'object') {
    const address = readString((nested as Record<string, unknown>).address);

    if (address != null) {
      return address;
    }
  }

  return (
    readString(obj.phone) ??
    readString(obj.phoneNumber) ??
    readString(obj.handle) ??
    readString(obj.username) ??
    readString(obj.name) ??
    readString(obj.Name) ??
    readString(obj.displayName)
  );
}

// ---------------------------------------------------------------------------
// The two subjects
// ---------------------------------------------------------------------------

/**
 * Everything that differs between the two stages. One value per source table,
 * and nothing else in this file branches on which one it has.
 */
interface SubjectDescriptor {
  stageId: string;
  /** Ledger `entity_type` AND `ci.identifier_claims.subject_type`. */
  subjectType: string;
  source: StageSource;
  /** Projects the slice's rows; must yield {@link SubjectRow}'s four columns. */
  loadSql: string;
  read(row: SubjectRow): ParticipantObservation[];
  /** The role that projects onto the single-entity column. */
  singularRole: ClaimRole;
  /** The role that projects onto the uuid[] column. */
  pluralRole: ClaimRole;
  /** One bulk UPDATE: $1 user, $2 ids, $3 singular entity ids, $4 plural jsonb. */
  projectSql: string;
}

/**
 * Where the sweep looks for communications, and which of those rows this stage
 * APPLIES to.
 *
 * ── READ THIS BEFORE ADDING THE NULL GUARD BACK ────────────────────────────
 *
 * All three services being replaced share this predicate:
 *
 *   `(from_entity_id IS NULL OR to_entity_ids IS NULL OR cardinality(to_entity_ids) = 0)`
 *
 * It is the ratchet, in its purest form. Those columns are this stage's OUTPUT,
 * so the predicate conflates three different facts into one NULL — never linked,
 * linked and nothing matched, and linked BADLY — and it does something the other
 * ratchets in this codebase do not: it declares a row finished the moment ONE
 * recipient resolves. A message to five people where one had a contact gets
 * `to_entity_ids = [one]`, `cardinality > 0`, and the other four can never be
 * linked no matter how many contacts arrive afterwards. That is not a corner
 * case; it is the normal shape of an inbox against a partial address book.
 *
 * What the predicate DOES say is what a row IS: a communication that names its
 * participants. `<> '{}'::jsonb` because an empty object is metadata in name
 * only, and offering it to every sweep forever costs a slice slot for a row that
 * can never produce a claim.
 */
export const PERSON_LINK_SOURCE: StageSource = {
  schema: 'ci',
  table: 'communications',
  idColumn: 'id',
  userColumn: 'user_id',
  predicate: `s.participants_metadata IS NOT NULL AND s.participants_metadata <> '{}'::jsonb`,
};

/**
 * Where the sweep looks for events.
 *
 * The key list is `EventParticipantBackfillService`'s candidate predicate with
 * its output-column guard REMOVED — that guard
 * (`organizer_entity_id IS NULL OR participant_entity_ids IS NULL OR
 * cardinality(participant_entity_ids) = 0`) is the same ratchet as above. What
 * survives is pure applicability: an event that names people.
 *
 * `is_deleted` is applicability too, not completion — `ci.events` is
 * soft-deleted, and linking a tombstone's participants is work whose result
 * nothing reads.
 */
export const EVENT_PERSON_LINK_SOURCE: StageSource = {
  schema: 'ci',
  table: 'events',
  idColumn: 'event_id',
  userColumn: 'user_id',
  predicate:
    `COALESCE(s.is_deleted, false) = false ` +
    `AND s.metadata IS NOT NULL ` +
    `AND ( s.metadata ? 'organizerEmail' OR s.metadata ? 'organizer_email' ` +
    `   OR s.metadata ? 'organizer' OR s.metadata ? 'Organizer' ` +
    `   OR s.metadata ? 'from' OR s.metadata ? 'From' ` +
    `   OR s.metadata ? 'participants' OR s.metadata ? 'Participants' ` +
    `   OR s.metadata ? 'attendees' OR s.metadata ? 'Attendees' ` +
    `   OR s.metadata ? 'to' OR s.metadata ? 'To' )`,
};

const COMMUNICATION_SUBJECT: SubjectDescriptor = {
  stageId: ENRICH_PERSON_LINK_STAGE_ID,
  subjectType: COMMUNICATION_SUBJECT_TYPE,
  source: PERSON_LINK_SOURCE,
  // `FALSE AS is_deleted`: ci.communications has no soft-delete column, and one
  // shape for both descriptors is worth more than a branch in the resolver.
  loadSql: `SELECT c.id,
                   c.participants_metadata AS metadata,
                   c.source_system         AS platform,
                   FALSE                   AS is_deleted
              FROM ci.communications c
             WHERE c.id = ANY($1::uuid[])
               AND c.user_id = $2::uuid`,
  read: readCommunicationObservations,
  singularRole: 'from',
  // `to` alone, NOT cc/bcc. `to_entity_ids` has existing readers that mean
  // "addressed to", and quietly folding carbon copies into it would change what
  // every one of them returns. The cc/bcc claims are still written, so promoting
  // them later is a projection-generation bump and not a re-parse.
  pluralRole: 'to',
  projectSql: `UPDATE ci.communications c
                  SET from_entity_id = COALESCE(u.singular_id, c.from_entity_id),
                      to_entity_ids  = CASE
                                         WHEN u.plural_ids IS NULL THEN c.to_entity_ids
                                         ELSE ARRAY(
                                           SELECT m.id
                                             FROM unnest(COALESCE(c.to_entity_ids, '{}'::uuid[]) || u.plural_ids)
                                                  WITH ORDINALITY AS m(id, ord)
                                            GROUP BY m.id
                                            ORDER BY min(m.ord))
                                       END
                 FROM (
                   SELECT t.id,
                          t.singular_id,
                          CASE
                            WHEN t.plural_json IS NULL THEN NULL
                            ELSE ARRAY(SELECT jsonb_array_elements_text(t.plural_json))::uuid[]
                          END AS plural_ids
                     FROM unnest($2::uuid[], $3::uuid[], $4::jsonb[])
                            AS t(id, singular_id, plural_json)
                 ) u
                WHERE c.user_id = $1::uuid
                  AND c.id = u.id`,
};

const EVENT_SUBJECT: SubjectDescriptor = {
  stageId: ENRICH_EVENT_PERSON_LINK_STAGE_ID,
  subjectType: EVENT_SUBJECT_TYPE,
  source: EVENT_PERSON_LINK_SOURCE,
  loadSql: `SELECT e.event_id  AS id,
                   e.metadata  AS metadata,
                   NULL::text  AS platform,
                   e.is_deleted
              FROM ci.events e
             WHERE e.event_id = ANY($1::uuid[])
               AND e.user_id = $2::uuid`,
  read: readEventObservations,
  singularRole: 'organizer',
  pluralRole: 'participant',
  projectSql: `UPDATE ci.events e
                  SET organizer_entity_id    = COALESCE(u.singular_id, e.organizer_entity_id),
                      participant_entity_ids = CASE
                                                 WHEN u.plural_ids IS NULL THEN e.participant_entity_ids
                                                 ELSE ARRAY(
                                                   SELECT m.id
                                                     FROM unnest(COALESCE(e.participant_entity_ids, '{}'::uuid[]) || u.plural_ids)
                                                          WITH ORDINALITY AS m(id, ord)
                                                    GROUP BY m.id
                                                    ORDER BY min(m.ord))
                                               END,
                      updated_at             = now()
                 FROM (
                   SELECT t.id,
                          t.singular_id,
                          CASE
                            WHEN t.plural_json IS NULL THEN NULL
                            ELSE ARRAY(SELECT jsonb_array_elements_text(t.plural_json))::uuid[]
                          END AS plural_ids
                     FROM unnest($2::uuid[], $3::uuid[], $4::jsonb[])
                            AS t(id, singular_id, plural_json)
                 ) u
                WHERE e.user_id = $1::uuid
                  AND e.event_id = u.id`,
};

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** One `ci.entity_identifiers` row, as the resolve query projects it. */
interface IndexedIdentifier {
  kind: string;
  value_normalized: string;
  entity_id: string;
  /** Needed to derive the index side's E.164 and adjudicate a phone match. */
  raw_value: string | null;
}

/** A resolution decision for one observation. */
interface Adjudication {
  entityId: string | null;
  confidence: number | null;
  method: string | null;
}

/** One projected link, read back out of the claims. */
interface ProjectedClaim {
  subject_id: string;
  role: string;
  entity_id: string;
  confidence: number;
}

/** What one subject row projects onto its two link columns. */
interface Projection {
  singular: string | null;
  plural: string[];
  /** The weakest confidence among the links actually projected. */
  minConfidence: number;
}

/**
 * The person-linking algorithm, once, for both source tables.
 *
 * Four statements per slice, no matter how many rows or participants it carries:
 * load, resolve, claim, project. Every one is `unnest()` over parallel arrays.
 * The per-row version of this is why `CommunicationLinkBackfillService` never
 * finished over a 22-year history and only the newest windows ever linked.
 *
 * NOT named `run`, and that is load-bearing: `stageWiring.spec.ts` discovers
 * stage classes by looking for a `run` on the prototype of every export under
 * `stages/`, and a helper with one would be treated as an unwired stage.
 */
export class PersonLinkResolver {
  constructor(
    private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
    private readonly subject: SubjectDescriptor,
  ) {}

  async link(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    const results = new Map<string, StageResult>();

    if (ids.length === 0) {
      return results;
    }

    const rows = await this.dataSource.query<SubjectRow[]>(this.subject.loadSql, [ids, ctx.userId]);
    const byId = new Map(rows.map((row) => [row.id, row]));

    // Answer for the ids that came back with no row FIRST, so the map is
    // complete even if the work below throws in a way this does not model.
    for (const id of ids) {
      if (!byId.has(id)) {
        // Deleted or re-owned between the sweep and the slice. A skip: there is
        // nothing to retry and nothing was lost.
        results.set(id, { outcome: 'skipped', reason: 'source_row_missing' });
      }
    }

    const observations: ParticipantObservation[] = [];
    /** Rows still in play: parsed at least one identifier. */
    const live: string[] = [];

    for (const row of rows) {
      if (row.is_deleted === true) {
        results.set(row.id, { outcome: 'skipped', reason: 'subject_deleted' });
        continue;
      }

      const meta = row.metadata;

      if (meta == null || Object.keys(meta).length === 0) {
        // The applicability predicate requires participant metadata, so this is
        // a row edited between the sweep and the slice, or a replayed dead
        // letter carrying stale ids. A skip WITH a reason, never a no-op.
        results.set(row.id, { outcome: 'skipped', reason: 'no_participants' });
        continue;
      }

      const observed = this.subject.read(row);

      if (observed.length === 0) {
        // Metadata naming participants, none of which normalises to anything —
        // empty strings, a lone "-", a `{}` attendee. Countable, which is the
        // whole point: this is the bucket that used to be indistinguishable from
        // "never processed".
        results.set(row.id, { outcome: 'skipped', reason: 'no_identifiers_parsed' });
        continue;
      }

      observations.push(...observed);
      live.push(row.id);
    }

    if (live.length === 0) {
      return results;
    }

    const indexed = await this.resolveIdentifiers(ctx.userId, observations);
    const claims = dedupeObservations(observations).map((observation) => ({
      observation,
      adjudication: adjudicate(observation.identifier, indexed),
    }));

    try {
      await this.writeClaims(ctx.userId, claims);
    } catch (err: unknown) {
      // One statement, one outcome: it committed or it did not, so every row in
      // it shares the verdict. Attributing it to one id would be a guess, and a
      // guess is what the reason column exists to replace.
      return this.failAll(results, live, 'claim_write_failed', err);
    }

    let projected: Map<string, Projection>;

    try {
      projected = await this.readProjection(ctx.userId, live);
    } catch (err: unknown) {
      return this.failAll(results, live, 'claim_read_failed', err);
    }

    const patches = [...projected.entries()].filter(
      ([, projection]) => projection.singular != null || projection.plural.length > 0,
    );
    const patched = new Set(patches.map(([id]) => id));

    // Everything the projection had nothing for, with the reason it had nothing.
    const resolvedBySubject = tallyResolved(claims, this.subject);

    for (const id of live) {
      if (patched.has(id)) {
        continue;
      }

      const tally = resolvedBySubject.get(id) ?? { projectable: 0, total: 0 };

      results.set(id, {
        outcome: 'skipped',
        reason:
          tally.projectable > 0
            ? // Resolved, and every one of them rejected by a human. CLEAN
              // proposes and a human disposes; this is the disposal, recorded
              // rather than silently re-derived on the next sweep.
              'all_claims_rejected'
            : tally.total > 0
              ? // Only cc/bcc matched. The claims exist and are queryable; no
                // column projects them today, which is a projection-generation
                // decision and not a failure.
                'no_projectable_role_resolved'
              : // The ordinary case on a corpus with no contacts yet: every
                // identifier was observed, normalised and claimed, and none of
                // them belongs to anybody. This is the number the appliance
                // could never produce — and the evidence is on disk, so the day
                // a contact import lands, a version bump links them all.
                'no_identifier_resolved',
        detail: { resolved: tally.total, projectable: tally.projectable },
      });
    }

    if (patches.length === 0) {
      return results;
    }

    try {
      await this.writeProjection(ctx.userId, patches);
    } catch (err: unknown) {
      return this.failAll(
        results,
        patches.map(([id]) => id),
        'link_write_failed',
        err,
      );
    }

    for (const [id, projection] of patches) {
      results.set(id, {
        outcome: 'done',
        // The WEAKEST link this row now carries, not an average and not the
        // best: a row is only as trustworthy as its worst-resolved participant,
        // and every one of these numbers came from `MATCH_CONFIDENCE` rather
        // than from a feeling.
        confidence: projection.minConfidence,
        detail: { singular: projection.singular, participants: projection.plural.length },
      });
    }

    return results;
  }

  /**
   * Every `ci.entity_identifiers` row any of these observations could match, in
   * ONE round trip.
   *
   * Raw SQL rather than `EntityIdentifierService.findEntityIdsByIdentifiers`,
   * for two reasons. The first is the one `EmbedStage` and `GeocodeStage` give:
   * reaching into another domain's module from `domains/pipeline` couples the
   * pipeline's graph to it for a projection. The second is specific — that
   * method's `IdentifierKey.kind` is the graph's `'email' | 'phone' | 'name'`,
   * which cannot express `handle`, and it returns entity ids ALONE, while
   * adjudicating a phone needs the index row's `raw_value` to derive its E.164.
   *
   * No join to `ci.entities.merged_into_entity_id`: the merge flow re-points
   * dependent rows in-service at merge time (20260803211455), so an identifier
   * pointing at a tombstone would itself be a bug in that flow, and following
   * the pointer here would hide it.
   */
  private async resolveIdentifiers(
    userId: string,
    observations: ParticipantObservation[],
  ): Promise<Map<string, IndexedIdentifier>> {
    const kinds: string[] = [];
    const values: string[] = [];
    const seen = new Set<string>();

    for (const { identifier } of observations) {
      const key = lookupKey(identifier.kind, identifier.valueNormalized);

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      kinds.push(identifier.kind);
      values.push(identifier.valueNormalized);
    }

    const out = new Map<string, IndexedIdentifier>();

    if (kinds.length === 0) {
      return out;
    }

    const rows = await this.dataSource.query<IndexedIdentifier[]>(
      `SELECT ei.kind, ei.value_normalized, ei.entity_id, ei.raw_value
         FROM ci.entity_identifiers ei
         JOIN unnest($2::text[], $3::text[]) AS t(kind, value)
           ON ei.kind = t.kind AND ei.value_normalized = t.value
        WHERE ei.owner_user_id = $1::uuid`,
      [userId, kinds, values],
    );

    for (const row of rows) {
      out.set(lookupKey(row.kind, row.value_normalized), row);
    }

    return out;
  }

  /**
   * Every observation, resolved or not, in ONE upsert.
   *
   * The unresolved rows are not noise — they are the reason this table exists.
   * `ON CONFLICT` refreshes only the RESOLUTION columns, so re-running over a
   * row already seen picks up identifiers the index has gained since without
   * disturbing the observation, its `created_at`, or a human's `disposition`.
   */
  private async writeClaims(
    userId: string,
    claims: Array<{ observation: ParticipantObservation; adjudication: Adjudication }>,
  ): Promise<void> {
    if (claims.length === 0) {
      return;
    }

    await this.dataSource.query(
      `INSERT INTO ci.identifier_claims AS ic
              (owner_user_id, subject_type, subject_id, role, kind, value_normalized, value_e164,
               raw_value, entity_id, confidence, method, stage, spec_version, observed_at)
       SELECT $1::uuid, $2, t.subject_id, t.role, t.kind, t.value_normalized, t.value_e164,
              t.raw_value, t.entity_id, t.confidence, t.method, $3, $4::int, now()
         FROM unnest($5::uuid[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[],
                     $11::uuid[], $12::real[], $13::text[])
              AS t(subject_id, role, kind, value_normalized, value_e164, raw_value,
                   entity_id, confidence, method)
       ON CONFLICT (owner_user_id, subject_type, subject_id, role, kind, value_normalized)
       DO UPDATE SET entity_id    = EXCLUDED.entity_id,
                     confidence   = EXCLUDED.confidence,
                     method       = EXCLUDED.method,
                     value_e164   = EXCLUDED.value_e164,
                     -- Never erase a raw value a previous writer captured: this
                     -- run may have seen the bare address where the first saw
                     -- "Dana Q. <dana@x>", and the display name is the only
                     -- thing that makes an unresolved claim reviewable.
                     raw_value    = COALESCE(EXCLUDED.raw_value, ic.raw_value),
                     stage        = EXCLUDED.stage,
                     spec_version = EXCLUDED.spec_version,
                     observed_at  = now()`,
      [
        userId,
        this.subject.subjectType,
        this.subject.stageId,
        PERSON_MATCH_SPEC_VERSION,
        claims.map(({ observation }) => observation.subjectId),
        claims.map(({ observation }) => observation.role),
        claims.map(({ observation }) => observation.identifier.kind),
        claims.map(({ observation }) => observation.identifier.valueNormalized),
        claims.map(({ observation }) => observation.identifier.valueE164),
        claims.map(({ observation }) => observation.identifier.rawValue),
        claims.map(({ adjudication }) => adjudication.entityId),
        claims.map(({ adjudication }) => adjudication.confidence),
        claims.map(({ adjudication }) => adjudication.method),
      ],
    );
  }

  /**
   * THE PROJECTION. Read back out of `ci.identifier_claims`, never out of this
   * run's in-memory answers.
   *
   * That is the whole design in one statement. Reading the table means the
   * columns reflect ALL the evidence — claims from earlier runs, from the
   * inline listener, from a future contact importer — and it means a human's
   * `disposition` is honoured by construction rather than by every writer
   * remembering to check it. `IS DISTINCT FROM 'rejected'` rather than
   * `<> 'rejected'`, because NULL means "proposed" and a NULL-propagating
   * comparison would silently project nothing at all.
   *
   * Ordered `confidence DESC, entity_id` so the singular slot takes the
   * strongest claim and ties break deterministically — an arbitrary winner would
   * make the column flap between sweeps for no visible reason.
   */
  private async readProjection(userId: string, ids: string[]): Promise<Map<string, Projection>> {
    const rows = await this.dataSource.query<ProjectedClaim[]>(
      `SELECT ic.subject_id, ic.role, ic.entity_id, ic.confidence
         FROM ci.identifier_claims ic
        WHERE ic.owner_user_id = $1::uuid
          AND ic.subject_type = $2
          AND ic.subject_id = ANY($3::uuid[])
          AND ic.role = ANY($4::text[])
          AND ic.entity_id IS NOT NULL
          AND ic.disposition IS DISTINCT FROM 'rejected'
        ORDER BY ic.subject_id, ic.confidence DESC, ic.entity_id`,
      [userId, this.subject.subjectType, ids, [this.subject.singularRole, this.subject.pluralRole]],
    );

    const out = new Map<string, Projection>();

    for (const row of rows) {
      const projection = out.get(row.subject_id) ?? { singular: null, plural: [], minConfidence: 1 };
      out.set(row.subject_id, projection);

      /** Whether THIS row is one of the links the columns will actually carry. */
      let projects = false;

      if (row.role === this.subject.singularRole) {
        if (projection.singular == null) {
          // First wins: the query is already ordered by confidence DESC.
          projection.singular = row.entity_id;
          projects = true;
        }
      } else if (!projection.plural.includes(row.entity_id)) {
        projection.plural.push(row.entity_id);
        projects = true;
      }

      // Only projected links move the confidence. A losing `from` claim and a
      // duplicate recipient are both real evidence, and neither ends up in a
      // column — letting them drag the number down would report a row as less
      // trustworthy than the links it actually carries.
      if (projects) {
        projection.minConfidence = Math.min(projection.minConfidence, row.confidence);
      }
    }

    return out;
  }

  /**
   * Write every projected row in ONE statement.
   *
   * The singular slot is `COALESCE(u.singular_id, c.from_entity_id)`: this
   * run's answer when it has one, else whatever was there. The plural slot
   * MERGES: the column's existing ids, in their order, followed by any this run
   * resolved that were not already present (`unnest ... WITH ORDINALITY`,
   * grouped on the id, ordered by first appearance). There is NO
   * `IS NULL`/`cardinality = 0` guard on either column, and there is no path
   * that shrinks a list or writes NULL — so a row this stage cannot resolve
   * keeps whatever a previous writer managed, and a row it can only PARTLY
   * resolve keeps the rest. The projection can only ever add. (Generation 1
   * replaced the plural column outright, which is how an importer's four
   * recipients became the one the index knew at sweep time.)
   */
  private async writeProjection(userId: string, patches: Array<[string, Projection]>): Promise<void> {
    await this.dataSource.query(this.subject.projectSql, [
      userId,
      patches.map(([id]) => id),
      patches.map(([, projection]) => projection.singular),
      // jsonb, because a uuid[][] cannot be unnested element-wise; each row's
      // array is rebuilt in SQL. NULL means "nothing to say", which the COALESCE
      // turns into "leave the column alone".
      patches.map(([, projection]) =>
        projection.plural.length > 0 ? JSON.stringify(projection.plural) : null,
      ),
    ]);
  }

  /** One shared failure for a whole statement's worth of ids. */
  private failAll(
    results: Map<string, StageResult>,
    ids: string[],
    reason: string,
    err: unknown,
  ): Map<string, StageResult> {
    const message = err instanceof Error ? err.message : String(err);

    for (const id of ids) {
      results.set(id, { outcome: 'failed', reason, detail: { message } });
    }

    this.logger.error(
      `${reason} for ${ids.length} ${this.subject.subjectType} rows`,
      err instanceof Error ? err : new Error(message),
    );

    return results;
  }
}

/** The `(kind, value)` key both the lookup map and the dedupe use. */
export function lookupKey(kind: string, valueNormalized: string): string {
  return `${kind}:${valueNormalized}`;
}

/**
 * Collapse observations that are the same CLAIM.
 *
 * Required, not an optimisation: `ON CONFLICT` cannot affect one row twice in a
 * single statement, so a duplicate would abort the whole upsert rather than
 * being harmlessly idempotent. Duplicates are ordinary — the same address twice
 * in a `to` header, or an attendee listed under two spellings that normalise
 * together. First wins, so the earliest raw value is the one kept.
 */
export function dedupeObservations(observations: ParticipantObservation[]): ParticipantObservation[] {
  const seen = new Set<string>();
  const out: ParticipantObservation[] = [];

  for (const observation of observations) {
    const key = `${observation.subjectId}|${observation.role}|${lookupKey(
      observation.identifier.kind,
      observation.identifier.valueNormalized,
    )}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    out.push(observation);
  }

  return out;
}

/**
 * Decide what one identifier resolves to, and how sure that makes us.
 *
 * ── The E.164 adjudication, which is where the widening earns its keep ─────
 *
 * A phone matches on `value_normalized`, which is the LAST TEN DIGITS — the
 * shared cross-repo join key, and lossy in a way that manufactures identities:
 * UK `+44 20 7946 0958` and US `(207) 946-0958` both normalise to `2079460958`.
 * So a ten-digit hit is not automatically a match:
 *
 *  - both sides state a country and AGREE → `phone_e164`, 1.0. The strongest
 *    phone evidence there is.
 *  - both state a country and DISAGREE → REFUSED, `phone_country_conflict`,
 *    resolved to nobody. The claim is still written, which is the point: the
 *    near-miss is on disk and countable instead of being a silent wrong link.
 *  - one or neither states a country → `phone_last10`, 0.85. We matched ten
 *    digits and cannot confirm the country, and the number says exactly that.
 *
 * Everything else is an exact match on the whole value, graded by what that
 * value can distinguish — see {@link MATCH_CONFIDENCE}.
 */
export function adjudicate(
  identifier: ClaimedIdentifier,
  indexed: Map<string, IndexedIdentifier>,
): Adjudication {
  const hit = indexed.get(lookupKey(identifier.kind, identifier.valueNormalized));

  if (hit == null) {
    // Observed, normalised, claimed — and belongs to nobody. NOT a failure and
    // not a silence: the row lands with `entity_id IS NULL` on the triage index.
    return { entityId: null, confidence: null, method: null };
  }

  if (identifier.kind === 'phone') {
    const indexedE164 = toE164(hit.raw_value);

    if (identifier.valueE164 != null && indexedE164 != null) {
      if (identifier.valueE164 !== indexedE164) {
        return { entityId: null, confidence: null, method: PHONE_COUNTRY_CONFLICT };
      }

      return { entityId: hit.entity_id, confidence: MATCH_CONFIDENCE.phone_e164, method: 'phone_e164' };
    }

    return { entityId: hit.entity_id, confidence: MATCH_CONFIDENCE.phone_last10, method: 'phone_last10' };
  }

  const method: MatchMethod =
    identifier.kind === 'email'
      ? 'email_exact'
      : identifier.kind === 'handle'
        ? 'handle_exact'
        : 'name_exact';

  return { entityId: hit.entity_id, confidence: MATCH_CONFIDENCE[method], method };
}

/**
 * How many of each subject's claims resolved, split by whether the role is one
 * the projection reads.
 *
 * This is what lets an empty projection carry an ACCURATE reason instead of one
 * blanket "nothing happened" — the difference between "no contact matches any
 * of these five addresses", "the only match was a cc, which no column projects"
 * and "a human rejected every one of them".
 */
function tallyResolved(
  claims: Array<{ observation: ParticipantObservation; adjudication: Adjudication }>,
  subject: SubjectDescriptor,
): Map<string, { projectable: number; total: number }> {
  const out = new Map<string, { projectable: number; total: number }>();

  for (const { observation, adjudication } of claims) {
    const tally = out.get(observation.subjectId) ?? { projectable: 0, total: 0 };

    if (adjudication.entityId != null) {
      tally.total += 1;

      if (observation.role === subject.singularRole || observation.role === subject.pluralRole) {
        tally.projectable += 1;
      }
    }

    out.set(observation.subjectId, tally);
  }

  return out;
}

// ---------------------------------------------------------------------------
// The two stages
// ---------------------------------------------------------------------------

/**
 * `enrich.person_link` — people-linking for `ci.communications`.
 *
 * Replaces the SWEEPS of `PersonStubBackfillService` and
 * `CommunicationLinkBackfillService`: their window walkers, their keyset
 * cursors, their per-window counters, their `onProgress` callbacks and the
 * fill-only-NULL guard all three shared. Neither service is deleted here —
 * Phase 9 owns removal, and the inline
 * `CommunicationParticipantLinkListener` stays for one release.
 *
 * ── One thing it deliberately does NOT do ──────────────────────────────────
 *
 * `PersonStubBackfillService` CREATES a stub Person for every unmatched
 * participant. This stage does not, and that is the decision, not an omission.
 * A stub is a person entity minted from one raw string, and once minted it is
 * indistinguishable from a real contact: `stub:email:dana@x` and the Dana in
 * your address book are two rows that nothing will ever merge on its own. The
 * stub-minting run on this appliance is what a duplicate detector now has to
 * clean up after.
 *
 * The claim replaces it outright. An unresolved claim records exactly what a
 * stub recorded — this address, on these rows, belonging to nobody — without
 * asserting that a person exists. Minting people from it is then a deliberate,
 * reviewable PROMOTE step over `ci.identifier_claims`, with the evidence still
 * attached. **CLEAN proposes; a human disposes.**
 */
@Injectable()
export class PersonLinkStage implements Stage {
  readonly id = ENRICH_PERSON_LINK_STAGE_ID;

  /** The DERIVED version — see {@link personLinkStageVersion}. Resolved once. */
  readonly version = personLinkStageVersion();

  /**
   * `pipeline-index`: Postgres-bound end to end. No provider, no model, no
   * object storage — four statements per slice. The plan sketches a fourth
   * `pipeline-enrich-link` queue; `PIPELINE_QUEUES` has three, one per resource
   * class, and this work belongs to the same class as the ledger writes it sits
   * beside.
   */
  readonly queue = PIPELINE_QUEUES.INDEX;

  readonly entityTypes = [COMMUNICATION_SUBJECT_TYPE] as const;

  readonly source = PERSON_LINK_SOURCE;

  private readonly resolver: PersonLinkResolver;

  constructor(@InjectDataSource() dataSource: DataSource, logger: LoggerService) {
    logger.setContext(PersonLinkStage.name);
    this.resolver = new PersonLinkResolver(dataSource, logger, COMMUNICATION_SUBJECT);
  }

  /**
   * Link one slice of communications.
   *
   * Idempotent, as the contract requires: the claim upsert is keyed on the
   * observation and the projection is derived from the table, so two dispatchers
   * racing the same id write the same rows and reach the same columns.
   */
  run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    return this.resolver.link(ctx, ids);
  }
}

/**
 * `enrich.event_person_link` — the same algorithm over `ci.events`.
 *
 * Replaces `EventParticipantBackfillService`'s sweep. A separate id because a
 * `Stage` has exactly one `source` and this is a different table; a separate id
 * ALSO means the two corpora can be swept, measured and re-opened
 * independently, which matters when one of them is 324,044 rows and the other is
 * an inbox.
 *
 * Everything that decides what a link MEANS — normalisation, matching,
 * confidence, projection, version — is shared with {@link PersonLinkStage}
 * through {@link PersonLinkResolver}, so the two cannot drift.
 */
@Injectable()
export class EventPersonLinkStage implements Stage {
  readonly id = ENRICH_EVENT_PERSON_LINK_STAGE_ID;

  readonly version = personLinkStageVersion();

  readonly queue = PIPELINE_QUEUES.INDEX;

  readonly entityTypes = [EVENT_SUBJECT_TYPE] as const;

  readonly source = EVENT_PERSON_LINK_SOURCE;

  private readonly resolver: PersonLinkResolver;

  constructor(@InjectDataSource() dataSource: DataSource, logger: LoggerService) {
    logger.setContext(EventPersonLinkStage.name);
    this.resolver = new PersonLinkResolver(dataSource, logger, EVENT_SUBJECT);
  }

  run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    return this.resolver.link(ctx, ids);
  }
}
