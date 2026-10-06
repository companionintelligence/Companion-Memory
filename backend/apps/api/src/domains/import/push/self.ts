/*
 * Who the appliance owner is, for the two chat exports that never say.
 *
 * A WhatsApp `_chat.txt` and a Facebook Messenger thread are flat transcripts:
 * every line carries a sender display name, and nothing marks which of those
 * names belongs to the account owner. There is no `is_from_me` column to read
 * — the way iMessage and SMS Backup & Restore both hand one over — so
 * `directionFor` in ./inputs finds nothing and every message, the owner's own
 * included, falls to that file's `inbound` default.
 *
 * That is why `toWhatsAppCommunicationInput` and
 * `toFacebookMessengerCommunicationInput` take an `isSelf` predicate instead of
 * reading direction off the record. This module builds it.
 *
 * Ported from CI-Import-Tools' `ci-server/people.ts`, which asked the server
 * over GraphQL (the `me` query) and cached the answer per credentials. The push
 * now runs INSIDE the server, so the same question is a query — and the cache
 * becomes "resolve once per push run", which is what {@link makeIsSelf}
 * returning a closure is for. A run is hundreds of thousands of records; this
 * must not be per-record work.
 */
import {
  type IdentifierKey,
  isPhoneShaped,
  normalizeEmail,
  normalizeName,
  normalizePhone,
} from '@ci/domains/graph';

/** Does this sender display name belong to the appliance owner? */
export type IsSelf = (name: string) => boolean;

/** How an input string was matched to the owner — used for trust-gated collation. */
export type OwnerMatchKind = 'email' | 'phone' | 'name';

export interface OwnerMatch {
  kind: OwnerMatchKind;
  /** 0–1 evidence strength for PersonalizationService.decide(person_self_merge). */
  confidence: number;
  /** The raw input that matched. */
  raw: string;
}

/** Fixed confidences for owner matches (email is authoritative account identity). */
export const OWNER_MATCH_CONFIDENCE = {
  email: 1,
  phone: 0.95,
  nameExact: 0.9,
  nameFuzzy: 0.8,
} as const;

/**
 * The fail-safe predicate: nobody is the owner.
 *
 * Returned whenever the owner's name cannot be resolved — no `ci.users` row, a
 * nameless account with no self Person, or a failed query. Every chat message
 * then keeps the `inbound` default, which is exactly the behaviour this repo
 * had before the mappers were wired in. Under-labelling the owner's own
 * messages is recoverable; labelling somebody else's message as the owner's is
 * a false authorship claim in their memory, and guessing to avoid a blank is
 * how you get one.
 */
export const NOBODY_IS_SELF: IsSelf = () => false;

/** Every name the appliance owner is known by, as read from the database. */
export interface SelfIdentity {
  /** `ci.users.name`, plus the name on the owner's own `is_self` Person row. */
  names: string[];
  /**
   * `ci.users.email`. Matched as an address exactly, and its local part
   * ("liam.broza" → "liam broza") as a display name, exactly too.
   */
  email: string | null;
  /** Phones on the self Person (`properties.phones` / `.phone`), for exact owner match. */
  phones: string[];
}

/**
 * The slice of TypeORM's `DataSource` this needs.
 *
 * Structural, so a unit test hands it a stub instead of standing up Postgres.
 */
export interface SelfIdentityReader {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T>;
}

/**
 * Both places the owner's name lives, in one round-trip.
 *
 * `ci.users` is the account: a name and an email, and on an appliance signed up
 * by email alone the name can be null. The owner's own Person row is the
 * display name onboarding let them choose — and it is routinely the better
 * match for a chat transcript, because it is the name a human picked rather
 * than whatever the OIDC provider handed over. `is_self` is checked on both the
 * typed column and the pre-migration `properties` key (see PersonEntity), and
 * merge tombstones are excluded so a merged-away duplicate cannot answer for
 * the owner.
 */
const SELF_IDENTITY_SQL = `
  SELECT u.name AS name, u.email AS email, NULL::jsonb AS phones_json
    FROM ci.users u
   WHERE u.id = $1::uuid
  UNION ALL
  SELECT e.name AS name, NULL::text AS email,
         CASE
           WHEN jsonb_typeof(e.properties->'phones') = 'array' THEN e.properties->'phones'
           WHEN COALESCE(e.properties->>'phone', '') <> '' THEN jsonb_build_array(e.properties->>'phone')
           ELSE '[]'::jsonb
         END AS phones_json
    FROM ci.entities e
   WHERE e.owner_user_id = $1::uuid
     AND e.entity_type = 'Person'
     AND e.merged_into_entity_id IS NULL
     AND (e.is_self IS TRUE OR e.properties ->> 'is_self' = 'true')`;

/** Read the owner's names. Callers decide what a failure means — see PushStage. */
export async function readSelfIdentity(db: SelfIdentityReader, userId: string): Promise<SelfIdentity> {
  const rows = await db.query<Array<{ name: string | null; email: string | null; phones_json: unknown }>>(
    SELF_IDENTITY_SQL,
    [userId],
  );

  const names: string[] = [];
  const phones: string[] = [];
  let email: string | null = null;

  for (const row of rows) {
    if (typeof row.name === 'string' && row.name.trim().length > 0) {
      names.push(row.name);
    }

    if (email == null && typeof row.email === 'string' && row.email.trim().length > 0) {
      email = row.email;
    }

    const rawPhones = row.phones_json;
    if (Array.isArray(rawPhones)) {
      for (const phone of rawPhones) {
        if (typeof phone === 'string' && phone.trim().length > 0 && !phones.includes(phone)) {
          phones.push(phone);
        }
      }
    }
  }

  return { names, email, phones };
}

/**
 * Fold a display name to its comparable form.
 *
 * {@link normalizeName} is the server's canonical display-name rule — NFKD
 * fold, strip diacritics, lowercase, collapse whitespace — the same one
 * `ci.entity_identifiers` is keyed on, so a name that matches here matches the
 * people-linking index too. Punctuation is dropped on top of it, because chat
 * exports write "Liam Broza (Work)" and address books write "Broza, Liam", and
 * neither of those is a different person.
 */
function fold(raw: string): string {
  return (normalizeName(raw) ?? '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Edit distance, single-row DP — the strings here are display names, not documents. */
function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_unused, j) => j);

  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }

  return prev[b.length];
}

/** Similarity in [0,1]: 1 − normalised edit distance. */
function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);

  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

/**
 * How close a near-miss may be and still be the owner.
 *
 * Ported verbatim from the retired repo, where it covered typos and dropped
 * middle initials without pulling in siblings who share a surname.
 */
const SIMILARITY_FLOOR = 0.8;

/**
 * Token containment, anchored on a substantial token.
 *
 * "Liam" is the owner when the account says "Liam Broza"; "L" is not, and
 * without the length anchor a stray initial matches every name it appears in.
 */
function containsAll(sub: string[], sup: string[]): boolean {
  return sub.every((token) => sup.includes(token)) && sub.some((token) => token.length >= 3);
}

interface SelfTarget {
  readonly full: string;
  readonly tokens: string[];
  /**
   * Only an exact folded match counts. Set for the email local part: it is a
   * name in disguise on most accounts, but it is also routinely a word like
   * "family", "home" or "info", and containment or edit distance against it
   * would claim anyone whose display name shares one token with it.
   */
  readonly exactOnly: boolean;
}

/**
 * Build the per-run predicate.
 *
 * Every target is folded ONCE here; the returned closure does the comparing,
 * memoised on the raw sender name because a corpus of half a million WhatsApp
 * messages holds a handful of distinct senders and asking the same question
 * about "Alice Example" 40,000 times is pure waste.
 *
 * A name matches on any of three grounds, in ascending cost: exact folded
 * equality, token containment either way ("Liam" vs "Liam Broza", "Liam A
 * Broza" vs "Liam Broza"), or ≥{@link SIMILARITY_FLOOR} edit similarity. The
 * account email's local part matches on the first ground only.
 *
 * FAIL SAFE: with nothing to compare against this returns
 * {@link NOBODY_IS_SELF} rather than a predicate that matches everything or
 * throws — see that constant for why the quiet answer is the right one.
 */
export function makeIsSelf(identity: SelfIdentity): IsSelf {
  const targets: SelfTarget[] = [];

  const add = (raw: string | null | undefined, exactOnly: boolean): void => {
    const full = raw ? fold(raw) : '';

    if (full && !targets.some((target) => target.full === full)) {
      targets.push({ full, tokens: full.split(' '), exactOnly });
    }
  };

  for (const name of identity.names) {
    add(name, false);
  }

  // The email local part is a name in disguise on most accounts, and on an
  // account created without a display name it is the only signal left. Exact
  // only: see SelfTarget.exactOnly. Added after the names, so a local part that
  // folds to the same string as a name keeps that name's looser matching.
  add(identity.email ? identity.email.split('@')[0].replace(/[._+-]/g, ' ') : null, true);

  if (targets.length === 0) {
    return NOBODY_IS_SELF;
  }

  const decided = new Map<string, boolean>();

  return (name: string): boolean => {
    const cached = decided.get(name);

    if (cached !== undefined) {
      return cached;
    }

    const candidate = fold(name);
    const tokens = candidate ? candidate.split(' ') : [];
    const verdict =
      candidate.length > 0 &&
      targets.some(
        (target) =>
          target.full === candidate ||
          (!target.exactOnly &&
            (containsAll(tokens, target.tokens) ||
              containsAll(target.tokens, tokens) ||
              similarity(candidate, target.full) >= SIMILARITY_FLOOR)),
      );

    decided.set(name, verdict);

    return verdict;
  };
}

/**
 * The display-name part of a participant string, or `null` when it has none.
 *
 * A mailbox header is `"Display Name" <addr@host>`; the address is not part of
 * the name, and folding it in ("liam broza x evil example") let a stranger's
 * address join the tokens a name test reads. So every address-shaped token,
 * bracketed or bare, is removed first, and a string that was only an address
 * has no name left.
 */
function displayNameOf(trimmed: string): string | null {
  const name = trimmed.replace(/\S+@\S+/g, ' ').trim();

  return name.length > 0 ? name : null;
}

/**
 * Is this email address or phone number itself the owner's?
 *
 * The only test that may bind an email or phone participant to the self
 * Person: the identifier has to BE one of the owner's, compared in the
 * normalized form `classifyParticipant` produced. A display name that merely
 * looks like the owner's says nothing about whose mailbox or number it came
 * from, so it is never consulted here; that is {@link matchOwner}'s name test,
 * and it belongs to name-only participants.
 */
export function matchOwnerIdentifier(
  identity: SelfIdentity,
  kind: 'email' | 'phone',
  valueNormalized: string,
): OwnerMatch | null {
  if (valueNormalized.length === 0) {
    return null;
  }

  if (kind === 'email') {
    const ownerEmail = identity.email ? normalizeEmail(identity.email) : null;

    return ownerEmail != null && ownerEmail === valueNormalized
      ? { kind: 'email', confidence: OWNER_MATCH_CONFIDENCE.email, raw: valueNormalized }
      : null;
  }

  return identity.phones.some((phone) => normalizePhone(phone) === valueNormalized)
    ? { kind: 'phone', confidence: OWNER_MATCH_CONFIDENCE.phone, raw: valueNormalized }
    : null;
}

/**
 * Is this communication participant the owner?
 *
 * The one rule the participant link listener and the stub backfill share. An
 * email or phone participant is the owner only when the address or number
 * itself is the owner's ({@link matchOwnerIdentifier}): its display name is
 * whatever the sender typed, so a stranger writing as `"<owner name>"
 * <x@elsewhere>` stays an ordinary contact. Only a name-only participant (a
 * chat display name) is matched by name, through {@link matchOwner}.
 */
export function matchParticipantOwner(
  identity: SelfIdentity,
  key: IdentifierKey,
  rawName: string,
): OwnerMatch | null {
  if (key.kind === 'name') {
    return matchOwner(identity, rawName.length > 0 ? rawName : key.valueNormalized);
  }

  return matchOwnerIdentifier(identity, key.kind, key.valueNormalized);
}

/**
 * Classify a raw string (email, phone, or display name) as the owner when possible.
 *
 * Prefer exact email / phone over fuzzy name so trust policy can treat account
 * email as authoritative while keeping name matches review-gated under
 * cautious/balanced.
 *
 * Each test reads only the part of the string it is about. The phone test runs
 * only on a string that is a phone number end to end ({@link isPhoneShaped}):
 * every digit in "Support 415 555 0100" used to be read as a number, and a
 * display name carrying the owner's digits matched as the owner's phone, an
 * exact identifier in every trust mode. The name test reads the display name
 * with every address in it removed, so a bare address has no name to test.
 */
export function matchOwner(identity: SelfIdentity, raw: string): OwnerMatch | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const emailNorm = normalizeEmail(trimmed);
  const ownerEmail = identity.email ? normalizeEmail(identity.email) : null;
  if (emailNorm != null && ownerEmail != null && emailNorm === ownerEmail) {
    return { kind: 'email', confidence: OWNER_MATCH_CONFIDENCE.email, raw: trimmed };
  }

  const phoneNorm = isPhoneShaped(trimmed) ? normalizePhone(trimmed) : null;
  if (phoneNorm != null) {
    // Always the OWNER's phones. There used to be an override here, and the
    // self-collation heal passed each candidate's own phones through it.
    for (const phone of identity.phones) {
      if (normalizePhone(phone) === phoneNorm) {
        return { kind: 'phone', confidence: OWNER_MATCH_CONFIDENCE.phone, raw: trimmed };
      }
    }
  }

  const name = displayNameOf(trimmed);
  const isSelf = makeIsSelf(identity);
  if (name == null || !isSelf(name)) {
    return null;
  }

  const folded = fold(name);
  const exactTargets = new Set<string>();
  for (const name of identity.names) {
    const f = fold(name);
    if (f) {
      exactTargets.add(f);
    }
  }

  if (identity.email) {
    const local = fold(identity.email.split('@')[0].replace(/[._+-]/g, ' '));
    if (local) {
      exactTargets.add(local);
    }
  }

  const confidence = exactTargets.has(folded)
    ? OWNER_MATCH_CONFIDENCE.nameExact
    : OWNER_MATCH_CONFIDENCE.nameFuzzy;

  return { kind: 'name', confidence, raw: trimmed };
}

/** True when this match is exact account email or phone — safe to redirect in all trust modes. */
export function isExactOwnerIdentifier(match: Pick<OwnerMatch, 'kind'>): boolean {
  return match.kind === 'email' || match.kind === 'phone';
}

/**
 * Whether ingest / stub minting should map this contact onto the self Person
 * instead of creating a separate stub.
 *
 * Exact email/phone always maps. Name matches map under balanced/hands_off so
 * WhatsApp "Bennett" does not mint a second Person; cautious keeps name stubs
 * for human review on People.
 */
export function shouldMapContactToSelf(
  match: OwnerMatch | null,
  trustMode: 'cautious' | 'balanced' | 'hands_off',
): boolean {
  if (match == null) {
    return false;
  }

  if (isExactOwnerIdentifier(match)) {
    return true;
  }

  return trustMode !== 'cautious';
}

/**
 * Trust dial for folding owner stubs into self (mirrors `person_self_merge` /
 * graph_entity decide rules without importing PersonalizationService — that
 * barrel closes a maintenance ↔ llm ↔ tools ↔ import cycle).
 *
 * `auto` needs an exact identifier, in every trust mode: a merge into self
 * moves every email and phone the stub holds onto the owner, and a name is not
 * evidence that those are the owner's. A name match is at most `review`.
 */
export function decideSelfCollation(
  trustMode: 'cautious' | 'balanced' | 'hands_off',
  match: Pick<OwnerMatch, 'kind' | 'confidence'>,
): 'auto' | 'review' | 'skip' {
  const { confidence } = match;

  if (confidence < 0.7) {
    return 'review';
  }

  if (trustMode === 'cautious') {
    return 'review';
  }

  if (trustMode === 'hands_off') {
    return isExactOwnerIdentifier(match) ? 'auto' : 'review';
  }

  // balanced — never silent-merge owner stubs; People UI is the review surface.
  return 'review';
}
