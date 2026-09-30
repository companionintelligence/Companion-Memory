/**
 * Phone numbers as duplicate-person evidence.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The same contact routinely lands twice: once from a contacts vCard, which
 * keeps the number as typed (`properties.Phones`, often with a `+1`), and
 * once as a Google Voice participant stub, whose only name IS the number and
 * whose `properties.phones` holds the ten-digit join key. The claim-based
 * pass in `DuplicateDetectStage` cannot pair them: it needs a phone claim on
 * BOTH sides, and the stub usually has none. What they share is the number
 * in their own Person properties, and until this module nothing read it as
 * evidence.
 *
 * ── The rule, in one place ──────────────────────────────────────────────────
 *
 * {@link PhoneHolders.adjudicate} is the ONLY judgement of what two people's
 * phone numbers say about them, and the only producer of a phone item at the
 * auto-merge tier (0.95). The duplicate detector calls it to write evidence
 * and caps every other phone item below that tier; the auto-merger calls it
 * again on the live rows immediately before each merge. Two call sites, one
 * rule.
 *
 *  - NUMBERS, NOT DIGITS. Every value is parsed to E.164 ({@link parsePhone}).
 *    A value that states its country (`+`, `00`, `011` under NANP, or eleven
 *    digits led by `1`) keeps it. A national value is read into the owner's
 *    region ONLY when that region is North America and the number is a valid,
 *    ordinary geographic NANP number ({@link nanpNumberClass}). Toll-free,
 *    premium, personal-communications and service numbers, extensions, short
 *    codes and anything invalid are never evidence.
 *  - A FAX LINE IS A MACHINE, NOT A PERSON. A number a record files as a fax
 *    (`properties.Faxes`, the vCard parser's `TEL;TYPE=FAX`) is never
 *    evidence, whatever else the corpus says about it: every card from one
 *    office lists the office fax, which is how two colleagues were proposed as
 *    one person at 85% ({@link FAX_FACT_PROPERTY_KEYS}).
 *  - A STATED FORM BEATS AN INFERRED ONE, per last ten digits; a raw value
 *    that was REFUSED beats the inferred reading of its own truncated join
 *    key; and a last-ten that anything in the corpus states with ANOTHER
 *    country is never read as North American
 *    ({@link PhoneHolders.foreignStated}): `+44 20 7946 0958` truncated to
 *    `2079460958` is not a Maine number.
 *  - THE REGION IS DERIVED, NOT ASSUMED ({@link derivePhoneRegion}): from the
 *    owner's own stated numbers, else an explicit list of North American time
 *    zones, and it must be corroborated by the corpus. No region, no
 *    inference: national-format pairs then stay a review question.
 *  - A SHARED NUMBER IS NOT A SHARED PERSON. Household lines and family plans
 *    put two people on one number, and a shared surname is exactly what such a
 *    household has in common. The exact tier needs the same first given name
 *    (or an unambiguous initial), or one side that is only a placeholder — an
 *    empty name, an email, an @handle, or its own number — AND a line census
 *    that finds no second real identity on the number. The census counts
 *    people by the same name rule, so two holders it would not fold ("Ada
 *    Quill" and "Ada Brightwater" on one office line) are two identities, and
 *    a name that fits both is ambiguous ({@link PhoneHolders.lineCensus}).
 *    Anything else is a review item labelled with the reason
 *    ({@link PHONE_EVIDENCE.check}).
 *  - A number held by more than {@link PHONE_MAX_HOLDERS} people, and any
 *    number the owner holds, is not evidence about anyone. A pair with a self
 *    endpoint is never graded exact: folding a contact into "you" on a phone
 *    number is a decision for the owner.
 *
 * Pure: no database access. The SQL helpers at the bottom only BUILD text.
 * Changing anything here that alters a verdict — including the NANP tables
 * and the time-zone list — requires a `DUPLICATE_SCORING_GENERATION` bump in
 * `DuplicateDetectStage`, so pending rows are rescored under the new rule.
 *
 * Not a replacement for `normalizePhone` (graph domain; the ten-digit join key)
 * or `toE164` (`clean.identifier_normalize`; stated forms only, never a
 * default region). `DuplicateDetectStage.spec` pins this module's last-ten to
 * the first and its stated form to the second.
 */

import {
  hasFamilyConflict,
  tokenizePersonName,
  type PersonNameToken,
  type TokenizedPersonName,
} from './personNameTokens';

// ---------------------------------------------------------------------------
// Scores and evidence kinds
// ---------------------------------------------------------------------------

/**
 * Evidence strength for a shared phone number.
 *
 *  - **exact 0.95** — one equal, valid, ordinary number, names compatible and
 *    the line not shared. The same tier as a shared email; folded without
 *    review. Only {@link PhoneHolders.adjudicate} writes it.
 *  - **review 0.85** — the same number, but a guard failed (names, a shared
 *    line, a self endpoint). Leads the review queue; never auto-merged.
 *  - **unconfirmed 0.75** — the same ten digits, but the country could not be
 *    confirmed for one side (no owner region, or the corpus states the digits
 *    under another country). The claim pass's `last10Only` tier, and the same
 *    number.
 */
export const PHONE_IDENTITY_SCORES = {
  exact: 0.95,
  review: 0.85,
  unconfirmed: 0.75,
} as const;

/** The evidence kinds this module writes into `ci.merge_candidates.evidence`. */
export const PHONE_EVIDENCE = {
  /** The shared number(s). Scored exact, review or unconfirmed. */
  match: 'phone',
  /** Why a shared-number pair was held back for review. Carries no weight. */
  check: 'phone_check',
  /** Same last ten digits, different countries: two numbers. Carries no weight. */
  conflict: 'phone_country_conflict',
} as const;

const MARKER_KINDS: ReadonlySet<string> = new Set([PHONE_EVIDENCE.check, PHONE_EVIDENCE.conflict]);

/** True for every evidence kind this module owns — the ones it replaces on re-adjudication. */
export function isPhoneEvidenceKind(kind: string): boolean {
  return kind === PHONE_EVIDENCE.match || MARKER_KINDS.has(kind);
}

/**
 * How many people may hold one number before it stops being evidence about
 * any of them: a switchboard, a family plan pasted into every card, a
 * support line. Six, the value of `MAX_GROUP_MEMBERS` in
 * `DuplicateDetectStage` (its spec pins the two together, and pins this equal
 * to `PROFILE_URL_MAX_HOLDERS`). Counted over the LAST TEN DIGITS — the key
 * the claim pass caps on — so two countries sharing digits count together,
 * which can only make the cap stricter. Changing it is a
 * `DUPLICATE_SCORING_GENERATION` bump.
 */
export const PHONE_MAX_HOLDERS = 6;

/**
 * The lower cap: how many distinct real identities one number may carry
 * before a same-given-name pair on it stops being exact. Two, so a household
 * line with "Ada Quill" and "Bo Quill" still folds the two copies of Ada, and
 * an office line with "Ada Quill" and "Ada Brightwater" the two copies of
 * either; a third identity makes the line a switchboard. A placeholder or
 * initial pair gets no such slack — its only corroboration IS the line, so
 * the line must carry at most one real identity. Any line with a holder who
 * could be either of two people is held for review whatever the count. See
 * {@link PhoneHolders.lineCensus}.
 */
export const PHONE_LINE_MAX_IDENTITIES = 2;

// ---------------------------------------------------------------------------
// The region
// ---------------------------------------------------------------------------

/**
 * The only region this module infers national numbers into. Everything else
 * is matched on stated forms alone, because a validator for it would be a
 * metadata table this repo does not carry.
 */
export type PhoneRegion = 'NANP';

/**
 * IANA zones whose owners dial the North American Numbering Plan: the US
 * (including its territories), Canada, and the Caribbean members, with their
 * legacy links. Explicit on purpose — `America/*` includes Mexico, Central
 * and South America, none of which is NANP — and `UTC` (the column default)
 * says nothing.
 */
export const NANP_TIMEZONES: ReadonlySet<string> = new Set([
  // United States
  'America/New_York',
  'America/Detroit',
  'America/Kentucky/Louisville',
  'America/Kentucky/Monticello',
  'America/Indiana/Indianapolis',
  'America/Indiana/Vincennes',
  'America/Indiana/Winamac',
  'America/Indiana/Marengo',
  'America/Indiana/Petersburg',
  'America/Indiana/Vevay',
  'America/Indiana/Tell_City',
  'America/Indiana/Knox',
  'America/Chicago',
  'America/Menominee',
  'America/North_Dakota/Center',
  'America/North_Dakota/New_Salem',
  'America/North_Dakota/Beulah',
  'America/Denver',
  'America/Boise',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'America/Juneau',
  'America/Sitka',
  'America/Metlakatla',
  'America/Yakutat',
  'America/Nome',
  'America/Adak',
  'Pacific/Honolulu',
  'America/Fort_Wayne',
  'America/Indianapolis',
  'America/Louisville',
  'America/Knox_IN',
  'America/Shiprock',
  'America/Atka',
  'Navajo',
  'US/Eastern',
  'US/Central',
  'US/Mountain',
  'US/Pacific',
  'US/Alaska',
  'US/Hawaii',
  'US/Arizona',
  'US/Michigan',
  'US/East-Indiana',
  'US/Indiana-Starke',
  'US/Aleutian',
  'US/Samoa',
  'EST5EDT',
  'CST6CDT',
  'MST7MDT',
  'PST8PDT',
  // US territories
  'America/Puerto_Rico',
  'America/St_Thomas',
  'America/Virgin',
  'Pacific/Guam',
  'Pacific/Saipan',
  'Pacific/Pago_Pago',
  'Pacific/Samoa',
  'Pacific/Midway',
  // Canada
  'America/Toronto',
  'America/Montreal',
  'America/Nipigon',
  'America/Thunder_Bay',
  'America/Iqaluit',
  'America/Pangnirtung',
  'America/Atikokan',
  'America/Winnipeg',
  'America/Rainy_River',
  'America/Rankin_Inlet',
  'America/Resolute',
  'America/Regina',
  'America/Swift_Current',
  'America/Edmonton',
  'America/Cambridge_Bay',
  'America/Yellowknife',
  'America/Inuvik',
  'America/Creston',
  'America/Dawson_Creek',
  'America/Fort_Nelson',
  'America/Whitehorse',
  'America/Dawson',
  'America/Vancouver',
  'America/Halifax',
  'America/Glace_Bay',
  'America/Moncton',
  'America/Goose_Bay',
  'America/Blanc-Sablon',
  'America/St_Johns',
  'Canada/Atlantic',
  'Canada/Central',
  'Canada/Eastern',
  'Canada/Mountain',
  'Canada/Newfoundland',
  'Canada/Pacific',
  'Canada/Saskatchewan',
  'Canada/Yukon',
  // Caribbean and Atlantic NANP members
  'America/Anguilla',
  'America/Antigua',
  'America/Barbados',
  'America/Cayman',
  'America/Dominica',
  'America/Grand_Turk',
  'America/Grenada',
  'America/Jamaica',
  'Jamaica',
  'America/Lower_Princes',
  'America/Montserrat',
  'America/Nassau',
  'America/Port_of_Spain',
  'America/Santo_Domingo',
  'America/St_Kitts',
  'America/St_Lucia',
  'America/St_Vincent',
  'America/Tortola',
  'Atlantic/Bermuda',
]);

/**
 * How much of the corpus must agree before a derived region is trusted: once
 * at least `minStated` values state their country, at least `minShare` of
 * them must be North American. An owner who moved to Los Angeles with a
 * phone book of +44 numbers does not get every national number read as +1.
 */
export const PHONE_REGION_CORROBORATION = { minStated: 20, minShare: 0.5 } as const;

/** Whether an E.164 number is in the North American plan — the only zone distinction this module draws. */
export function isNanpE164(e164: string): boolean {
  return /^\+1\d{10}$/.test(e164);
}

/**
 * The owner's dialling region, or null when it cannot be derived honestly.
 *
 *  1. The owner's own stated numbers: all North American gives NANP; all
 *     elsewhere gives null, whatever the time zone says. A mix falls through.
 *  2. Otherwise {@link NANP_TIMEZONES}.
 *  3. Either answer must then be corroborated by {@link PHONE_REGION_CORROBORATION}.
 *
 * Arguments are E.164 strings, so the caller never has to know a calling-code
 * table: {@link isNanpE164} is the only question asked of them.
 */
export function derivePhoneRegion(input: {
  selfStatedNumbers: readonly string[];
  timezone: string | null | undefined;
  statedNumbers: readonly string[];
}): PhoneRegion | null {
  const selfZones = new Set(input.selfStatedNumbers.map(isNanpE164));
  let region: PhoneRegion | null = null;

  if (selfZones.size === 1) {
    if (!selfZones.has(true)) {
      return null;
    }

    region = 'NANP';
  } else if (input.timezone != null && NANP_TIMEZONES.has(input.timezone)) {
    region = 'NANP';
  }

  if (region == null) {
    return null;
  }

  const { minStated, minShare } = PHONE_REGION_CORROBORATION;

  if (input.statedNumbers.length >= minStated) {
    const nanp = input.statedNumbers.filter(isNanpE164).length;

    if (nanp / input.statedNumbers.length < minShare) {
      return null;
    }
  }

  return region;
}

// ---------------------------------------------------------------------------
// NANP numbers
// ---------------------------------------------------------------------------

/** What kind of North American number ten digits are. Only `geographic` is ever evidence. */
export type NanpNumberClass =
  | 'geographic'
  | 'toll_free'
  | 'premium'
  | 'non_geographic'
  | 'service'
  | 'invalid';

/** Toll-free, and the NPAs NANPA reserves for toll-free expansion. */
const TOLL_FREE_NPAS: ReadonlySet<string> = new Set([
  '800',
  '833',
  '844',
  '855',
  '866',
  '877',
  '888',
  '822',
  '880',
  '881',
  '882',
  '883',
  '884',
  '885',
  '886',
  '887',
  '889',
]);

/**
 * Non-geographic NPAs: 456 (international inbound), 500 and 521–529, 533,
 * 544, 566, 577, 588 (personal communications — follow-me numbers that ring
 * whoever holds them now), 600 and 622 (Canadian non-geographic), 700 (carrier
 * services), 710 (US government). 520 is NOT here: it is Tucson.
 */
const NON_GEOGRAPHIC_NPAS: ReadonlySet<string> = new Set([
  '456',
  '500',
  '521',
  '522',
  '523',
  '524',
  '525',
  '526',
  '527',
  '528',
  '529',
  '533',
  '544',
  '566',
  '577',
  '588',
  '600',
  '622',
  '700',
  '710',
]);

/** Exchanges that are carrier or test services, never a subscriber (N11 is checked separately). */
const SERVICE_EXCHANGES: ReadonlySet<string> = new Set(['950', '958', '959']);

/**
 * Classify ten NANP digits (`NPA NXX XXXX`). Shape rules first — NPA and NXX
 * start 2–9; an NPA is never N11 (a service code), N9X (reserved for
 * expansion), 37X or 96X (reserved), nor 555 (the fictional area code); ten
 * identical digits are a placeholder somebody typed — then the service
 * ranges. The `555-01XX` lines under a real area code stay geographic: they
 * are the fiction range, which is what every fixture in this repo uses.
 */
export function nanpNumberClass(ten: string): NanpNumberClass {
  if (!/^\d{10}$/.test(ten) || /^(\d)\1{9}$/.test(ten)) {
    return 'invalid';
  }

  const npa = ten.slice(0, 3);
  const nxx = ten.slice(3, 6);

  if (npa[0] < '2' || nxx[0] < '2') {
    return 'invalid';
  }

  if (npa[1] === '9' || (npa[1] === '1' && npa[2] === '1') || /^(?:37|96)/.test(npa) || npa === '555') {
    return 'invalid';
  }

  if (TOLL_FREE_NPAS.has(npa)) {
    return 'toll_free';
  }

  if (npa === '900' || nxx === '976') {
    return 'premium';
  }

  if (NON_GEOGRAPHIC_NPAS.has(npa)) {
    return 'non_geographic';
  }

  if ((nxx[1] === '1' && nxx[2] === '1') || SERVICE_EXCHANGES.has(nxx)) {
    return 'service';
  }

  return 'geographic';
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Why a raw value is or is not a usable number.
 *
 * `fax` is never returned by {@link parsePhone}: it is how
 * {@link extractPhoneFacts} records digits the record itself files as a fax,
 * and it outranks every other reading of them ({@link PhoneHolders.resolve}).
 */
export type PhoneParseStatus =
  | 'ok'
  | 'invalid'
  | 'service'
  | 'no_region'
  | 'extension'
  | 'short'
  | 'letters'
  | 'fax';

/** One raw phone value, read. */
export interface ParsedPhone {
  status: PhoneParseStatus;
  /** The E.164 form. Set only when `status` is `ok`. */
  e164: string | null;
  /** The value itself said which country it is in. */
  stated: boolean;
  /**
   * The last ten digits (all of them when fewer) — `normalizePhone`'s join
   * key, for every status, so a refused value can still be matched to the
   * lines it collides with. Empty when the value has no digits.
   *
   * For a value carrying an extension this is the key the join key USED to
   * give it: `normalizePhone` now refuses such a value outright, but records
   * written before it did hold the truncation in `phones`, and this is what
   * lets {@link PhoneHolders.resolve} see the refusal on that same line.
   */
  l10: string;
}

/** Invisible format characters (bidi marks, zero-width spaces) contact exports paste into numbers. */
const FORMAT_CHARACTERS = /\p{Cf}/gu;
/** Every dash a phone number is typed with, folded to `-`. */
const DASHES = /[‐-―−﹘﹣－]/g;
/** `x123`, `ext. 123`, `extension 123` at the end, or a `;`/`,`/`#` dial-string suffix. */
const EXTENSION = /(?:\b(?:ext|x|extension)\.?\s*\d+\s*$)|[;,#]/i;
/** What a phone number may be written with once format characters and dashes are folded. */
const PHONE_CHARACTERS = /^\+?[\d\s().\-/]+$/;
/** Fewer digits than the shortest subscriber number anywhere: a short code or a fragment. */
const MIN_DIGITS = 7;
/** E.164 bounds, as `toE164` applies them. */
const E164_MIN_DIGITS = 8;
const E164_MAX_DIGITS = 15;

const PARSE_MEMO = new Map<string, ParsedPhone>();
/** A bound, so a long-lived worker cannot grow the memo without limit across many corpora. */
const PARSE_MEMO_LIMIT = 200_000;

function lastTen(digits: string): string {
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function readNanp(ten: string, stated: boolean, l10: string): ParsedPhone {
  const numberClass = nanpNumberClass(ten);

  if (numberClass === 'geographic') {
    return { status: 'ok', e164: `+1${ten}`, stated, l10 };
  }

  return { status: numberClass === 'invalid' ? 'invalid' : 'service', e164: null, stated, l10 };
}

function parseUncached(raw: string, region: PhoneRegion | null): ParsedPhone {
  const cleaned = raw.replace(FORMAT_CHARACTERS, '').replace(DASHES, '-').trim();
  const digits = cleaned.replace(/\D/g, '');
  const l10 = lastTen(digits);
  const refused = (status: PhoneParseStatus, stated = false): ParsedPhone => ({
    status,
    e164: null,
    stated,
    l10,
  });

  if (EXTENSION.test(cleaned)) {
    return refused('extension');
  }

  if (/\p{L}/u.test(cleaned)) {
    return refused('letters');
  }

  if (!PHONE_CHARACTERS.test(cleaned)) {
    return refused('invalid');
  }

  if (digits.length < MIN_DIGITS) {
    return refused('short');
  }

  let international: string | null = null;

  if (cleaned.startsWith('+')) {
    international = digits;
  } else if (digits.startsWith('00')) {
    international = digits.slice(2);
  } else if (region === 'NANP' && digits.startsWith('011')) {
    international = digits.slice(3);
  } else if (digits.length === 11 && digits.startsWith('1')) {
    // `1NXXNXXXXXX` is NANP by construction; no other country code is a bare 1.
    international = digits;
  }

  if (international != null) {
    if (international.startsWith('1')) {
      return international.length === 11
        ? readNanp(international.slice(1), true, l10)
        : refused('invalid', true);
    }

    if (
      international.startsWith('0') ||
      international.length < E164_MIN_DIGITS ||
      international.length > E164_MAX_DIGITS
    ) {
      return refused('invalid', true);
    }

    return { status: 'ok', e164: `+${international}`, stated: true, l10 };
  }

  if (region !== 'NANP') {
    return refused('no_region');
  }

  // A national number under NANP is exactly ten digits. A trunk-prefixed
  // foreign national number ("020 7946 0958") is eleven, and is refused here
  // rather than truncated into a US one.
  return digits.length === 10 ? readNanp(digits, false, l10) : refused('invalid');
}

/**
 * Read one raw value in `region`. Memoized per (region, raw): the detector
 * parses the whole corpus on every slice.
 */
export function parsePhone(raw: string, region: PhoneRegion | null): ParsedPhone {
  const key = `${region ?? '-'}\u0000${raw}`;
  const cached = PARSE_MEMO.get(key);

  if (cached != null) {
    return cached;
  }

  if (PARSE_MEMO.size >= PARSE_MEMO_LIMIT) {
    PARSE_MEMO.clear();
  }

  const parsed = parseUncached(raw, region);
  PARSE_MEMO.set(key, parsed);

  return parsed;
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/**
 * Every `properties` key {@link extractPhoneFacts} reads: the vCard parser's
 * raw `Phones`, and the pre-normalized `phones` / `phone` join keys that every
 * importer writes.
 */
export const PHONE_FACT_PROPERTY_KEYS = ['Phones', 'phones', 'phone'] as const;

/**
 * The `properties` keys that hold numbers the record files as FAX lines — the
 * vCard parser's `Faxes` (`TEL;TYPE=FAX`). Read by {@link extractPhoneFacts}
 * only to REFUSE those digits: a fax is office equipment, and one office's
 * fax is on every card from that office, so a shared fax says nothing about
 * whether two people are one. The refusal holds even when the same digits
 * also sit in a phone key — the vCard parser's identity key can be the fax,
 * and then `phones` carries it too.
 */
export const FAX_FACT_PROPERTY_KEYS = ['Faxes'] as const;

/** Every key the facts are read from — what the SQL loads, and what makes a Person part of the corpus. */
const FACT_SQL_KEYS: readonly string[] = [...PHONE_FACT_PROPERTY_KEYS, ...FAX_FACT_PROPERTY_KEYS];

/** A name that says nothing about who the person is — the Google Voice stub case. */
export type PhonePlaceholder = 'empty' | 'email' | 'handle' | 'own_number';

/** Everything one person's record says about one last-ten. */
export interface PhoneLine {
  /** Stated E.164 forms of these digits (usually one). */
  stated: ReadonlySet<string>;
  /** The owner-region reading of a national value, or null. */
  inferred: string | null;
  /** Every status a value with these digits was refused with. */
  refused: ReadonlySet<PhoneParseStatus>;
}

/** What one person's own record says about their phone identity. */
export interface PhoneFacts {
  /** Last-ten → what the record says about it. */
  lines: ReadonlyMap<string, PhoneLine>;
  /** The display name as stored. */
  rawName: string | null;
  /** The display name, tokenized once. Null for a placeholder or an unusable name. */
  name: TokenizedPersonName | null;
  placeholder: PhonePlaceholder | null;
  /** The display name is a phone number that is none of this person's own. */
  nameIsOtherNumber: boolean;
  isSelf: boolean;
}

function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return [String(value)];
  }

  if (Array.isArray(value)) {
    return value.flatMap(stringsOf);
  }

  return [];
}

/** The raw values `properties` holds under `keys`, in key order. */
function propertyValues(
  properties: Readonly<Record<string, unknown>> | null | undefined,
  keys: readonly string[],
): string[] {
  const props = properties ?? {};

  return keys.flatMap((key) => stringsOf(props[key])).filter((value) => value.trim() !== '');
}

/** The raw phone values `properties` holds, in key order. */
function propertyPhoneValues(properties: Readonly<Record<string, unknown>> | null | undefined): string[] {
  return propertyValues(properties, PHONE_FACT_PROPERTY_KEYS);
}

/** The raw values `properties` files as fax lines. */
function propertyFaxValues(properties: Readonly<Record<string, unknown>> | null | undefined): string[] {
  return propertyValues(properties, FAX_FACT_PROPERTY_KEYS);
}

const HANDLE_NAME = /^@[\w.]{2,}$/;
const EMAIL_NAME = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A letterless display name with at least {@link MIN_DIGITS} digits — a number, not a name. */
function numericName(name: string): boolean {
  return !/\p{L}/u.test(name) && name.replace(/\D/g, '').length >= MIN_DIGITS;
}

/**
 * What a display name is, as far as phone identity cares: a placeholder
 * (with its kind), a number that is NOT this person's own (`other_number`),
 * or a real name (null).
 *
 * "Own" means one of the numbers `properties` states, in any formatting — the
 * Google Voice stub named `+1 (202) 555-0142` whose `phones` is
 * `2025550142`. A numeric name on a record with no phone properties at all is
 * its own number too: it is the only one the record has.
 */
export function classifyPhoneName(
  name: string | null | undefined,
  properties?: Readonly<Record<string, unknown>> | null,
): PhonePlaceholder | 'other_number' | null {
  const trimmed = (name ?? '').replace(FORMAT_CHARACTERS, '').trim();

  if (trimmed === '') {
    return 'empty';
  }

  if (HANDLE_NAME.test(trimmed)) {
    return 'handle';
  }

  if (EMAIL_NAME.test(trimmed)) {
    return 'email';
  }

  if (!numericName(trimmed)) {
    return null;
  }

  const own = new Set(
    [...propertyPhoneValues(properties), ...propertyFaxValues(properties)]
      .map((value) => lastTen(value.replace(/\D/g, '')))
      .filter((digits) => digits.length >= MIN_DIGITS),
  );

  return own.size === 0 || own.has(lastTen(trimmed.replace(/\D/g, ''))) ? 'own_number' : 'other_number';
}

/** True when a display name is not a person's name at all — for choosing which name survives a merge. */
export function isPlaceholderPersonName(name: string | null | undefined): boolean {
  const trimmed = (name ?? '').replace(FORMAT_CHARACTERS, '').trim();

  return trimmed === '' || HANDLE_NAME.test(trimmed) || EMAIL_NAME.test(trimmed) || numericName(trimmed);
}

/**
 * The phone facts one person's record states, read in `region`.
 *
 * Reads ONLY {@link PHONE_FACT_PROPERTY_KEYS}, {@link FAX_FACT_PROPERTY_KEYS}
 * and a display name that is a number. Values are grouped by last ten digits;
 * within one person a stated form is kept beside the inferred reading, and
 * {@link PhoneHolders.resolve} decides between them with the corpus in view.
 * A fax value only ever marks its digits `fax`: it contributes no reading.
 */
export function extractPhoneFacts(
  properties: Readonly<Record<string, unknown>> | null | undefined,
  name: string | null | undefined,
  isSelf: boolean,
  region: PhoneRegion | null,
): PhoneFacts {
  const classified = classifyPhoneName(name, properties);
  const values = propertyPhoneValues(properties);

  if (classified === 'own_number' || classified === 'other_number') {
    values.push(name as string);
  }

  const lines = new Map<
    string,
    { stated: Set<string>; inferred: string | null; refused: Set<PhoneParseStatus> }
  >();

  for (const value of values) {
    const parsed = parsePhone(value, region);

    if (parsed.l10.length < MIN_DIGITS) {
      continue;
    }

    let line = lines.get(parsed.l10);

    if (line == null) {
      line = { stated: new Set(), inferred: null, refused: new Set() };
      lines.set(parsed.l10, line);
    }

    if (parsed.status !== 'ok') {
      line.refused.add(parsed.status);
    } else if (parsed.stated) {
      line.stated.add(parsed.e164 as string);
    } else {
      line.inferred = parsed.e164;
    }
  }

  for (const value of propertyFaxValues(properties)) {
    const { l10 } = parsePhone(value, region);

    if (l10.length < MIN_DIGITS) {
      continue;
    }

    const line = lines.get(l10) ?? { stated: new Set<string>(), inferred: null, refused: new Set() };
    line.refused.add('fax');
    lines.set(l10, line);
  }

  const placeholder = classified === 'other_number' ? null : classified;

  return {
    lines,
    rawName: name ?? null,
    name: placeholder == null && classified !== 'other_number' ? tokenizePersonName(name) : null,
    placeholder,
    nameIsOtherNumber: classified === 'other_number',
    isSelf,
  };
}

/** Every stated E.164 a record carries, read with no region — the input to {@link derivePhoneRegion}. */
export function statedPhoneNumbers(
  properties: Readonly<Record<string, unknown>> | null | undefined,
  name: string | null | undefined,
): string[] {
  const values = propertyPhoneValues(properties);

  if (name != null && numericName(name.replace(FORMAT_CHARACTERS, '').trim())) {
    values.push(name);
  }

  return values.flatMap((value) => {
    const parsed = parsePhone(value, null);

    return parsed.status === 'ok' && parsed.stated ? [parsed.e164 as string] : [];
  });
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** How two real display names relate, for the purpose of sharing a phone number. */
export type GivenNameRelation =
  | 'same'
  | 'initial'
  | 'prefix'
  | 'given_conflict'
  | 'family_conflict'
  | 'suffix_conflict'
  | 'relational'
  | 'unknown';

/** Professional suffixes the tokenizer also drops; stripped before the generational one is read. */
const PROFESSIONAL_SUFFIX = /[\s,]+(?:phd|md|esq|jd)\.?\s*$/i;
const GENERATIONAL_SUFFIX = /(?:^|[\s,])(jr|sr|ii|iii|iv)\.?\s*$/i;

/**
 * The generational suffix of a raw display name ("jr", "sr", "ii"…), or null.
 * Read from the RAW name because `tokenizePersonName` drops it — which is
 * right for a name match and wrong here, where "Ada Quill Sr." and "Ada
 * Quill Jr." sharing a family landline are the textbook two people.
 */
export function generationalSuffix(raw: string | null | undefined): string | null {
  let name = (raw ?? '').trim();

  while (PROFESSIONAL_SUFFIX.test(name)) {
    name = name.replace(PROFESSIONAL_SUFFIX, '');
  }

  return GENERATIONAL_SUFFIX.exec(name)?.[1]?.toLowerCase() ?? null;
}

/** The first token when it is a given name or an initial; null for a lone surname ("Mr Quill"). */
function firstGiven(name: TokenizedPersonName): string | null {
  const first: PersonNameToken | undefined = name.tokens[0];

  return first != null && (first.role === 'given' || first.role === 'initial') ? first.value : null;
}

/**
 * How two real names relate on the axis a shared phone needs: the FIRST GIVEN
 * NAME. A shared surname is what a household has in common, so it never
 * corroborates; a different one is a conflict.
 *
 *  - `same` — same first given token ("Ada Quill" / "Ada").
 *  - `initial` — one side is a single initial of the other ("A. Quill" / "Ada").
 *  - `prefix` — one given name starts the other ("Chris" / "Christine"): a
 *    nickname, or a sibling. Review.
 *  - `given_conflict`, `family_conflict`, `suffix_conflict` (a Jr/Sr pair, or
 *    a suffix on one side only), `relational` ("Ada's brother"), `unknown`
 *    (no usable given name — a lone surname, an honorific and a surname).
 */
export function givenNameRelation(
  left: string | null | undefined,
  right: string | null | undefined,
): GivenNameRelation {
  return relateNames(tokenizePersonName(left), tokenizePersonName(right), left, right);
}

/**
 * {@link givenNameRelation} on names already tokenized. The raw names are still
 * needed: the generational suffix is read from them, because the tokenizer
 * drops it.
 */
function relateNames(
  a: TokenizedPersonName | null,
  b: TokenizedPersonName | null,
  left: string | null | undefined,
  right: string | null | undefined,
): GivenNameRelation {
  if (a == null || b == null) {
    return 'unknown';
  }

  if (a.isRelational || b.isRelational) {
    return 'relational';
  }

  const givenA = firstGiven(a);
  const givenB = firstGiven(b);

  if (givenA == null || givenB == null) {
    return 'unknown';
  }

  // A lone token that is the other side's surname is a surname, not a given name.
  if ((a.tokens.length === 1 && b.family === givenA) || (b.tokens.length === 1 && a.family === givenB)) {
    return 'unknown';
  }

  if (generationalSuffix(left) !== generationalSuffix(right)) {
    return 'suffix_conflict';
  }

  let relation: GivenNameRelation;

  if (givenA === givenB) {
    relation = 'same';
  } else if (
    (givenA.length === 1 && givenB.startsWith(givenA)) ||
    (givenB.length === 1 && givenA.startsWith(givenB))
  ) {
    relation = 'initial';
  } else if (givenA.startsWith(givenB) || givenB.startsWith(givenA)) {
    relation = 'prefix';
  } else {
    return 'given_conflict';
  }

  return hasFamilyConflict(a, b) ? 'family_conflict' : relation;
}

/** The relations under which two names may belong to one person — the only ones a pair folds on. */
const ONE_PERSON_RELATIONS: ReadonlySet<GivenNameRelation> = new Set(['same', 'initial']);

/**
 * The first given name or initial a record's name can be told apart by: set
 * for a real, non-relational name that starts with one, null otherwise (a
 * placeholder has no name at all). Every non-placeholder record without one
 * is an identity of its own in the line census.
 */
function censusGiven(facts: PhoneFacts): string | null {
  return facts.name != null && !facts.name.isRelational ? firstGiven(facts.name) : null;
}

function hasCensusName(facts: PhoneFacts): boolean {
  return censusGiven(facts) != null;
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/** Why a shared-number pair was held back for a human. */
export type PhoneCheckReason =
  | 'self_endpoint'
  | 'numeric_name_mismatch'
  | 'given_name_conflict'
  | 'given_name_prefix'
  | 'family_name_conflict'
  | 'suffix_conflict'
  | 'relational_name'
  | 'unknown_name'
  | 'shared_line'
  | 'unadjudicated';

/** Why shared digits are not evidence at all. */
export type PhoneUnusableReason =
  | 'over_common'
  | 'owner_number'
  | 'service'
  | 'invalid'
  | 'extension'
  | 'short'
  | 'fax';

/** Where the country of an exact match came from. */
export type PhoneBasis = 'stated_both' | 'stated_one' | 'inferred_both';

/**
 * What two people's phone numbers say about them.
 *
 *  - `absent` — no shared last ten digits. Says nothing.
 *  - `unusable` — the shared digits are not a number anyone can be identified
 *    by (toll-free, invalid, the owner's, over-common…). No evidence.
 *  - `country_conflict` — the same ten digits in two countries. Two numbers.
 *  - `unconfirmed` — the same ten digits, country unknown for a side.
 *  - `review` — the same number, but a guard failed.
 *  - `exact` — the same number, and nothing says it is two people.
 */
export type PhoneVerdict =
  | { kind: 'absent' }
  | { kind: 'unusable'; reasons: PhoneUnusableReason[] }
  | { kind: 'country_conflict'; conflicts: Array<{ left: string; right: string }> }
  | { kind: 'unconfirmed'; digits: string[] }
  | { kind: 'review'; numbers: string[]; reasons: PhoneCheckReason[] }
  | { kind: 'exact'; numbers: string[]; basis: PhoneBasis };

/** One person's reading of one last-ten, with the corpus in view. */
export type PhoneReading =
  | { kind: 'number'; e164: string; stated: boolean }
  | { kind: 'unconfirmed' }
  | { kind: 'refused'; reasons: PhoneUnusableReason[] };

const RELATION_REASON: Readonly<Record<string, PhoneCheckReason>> = {
  given_conflict: 'given_name_conflict',
  prefix: 'given_name_prefix',
  family_conflict: 'family_name_conflict',
  suffix_conflict: 'suffix_conflict',
  relational: 'relational_name',
  unknown: 'unknown_name',
};

function refusalReason(status: PhoneParseStatus): PhoneUnusableReason {
  switch (status) {
    case 'service':
    case 'extension':
    case 'short':
    case 'fax':
      return status;
    default:
      return 'invalid';
  }
}

/**
 * Who holds each number across the owner's whole corpus, and the corpus-wide
 * facts every verdict needs: the holder cap, the owner's own lines, the
 * foreign-stated guard and the line census.
 *
 * Built from the WHOLE corpus, never a slice: a slice of 200 can hold two
 * members of a seven-member switchboard, and from inside the slice that
 * looks like a pair. Mutable on purpose, like `ProfileUrlHolders`: the
 * auto-merger keeps one per drain and re-records both endpoints after every
 * merge, so a decision late in a long drain sees the corpus as it is then.
 */
export class PhoneHolders {
  /** last-ten → everyone whose record carries those digits. */
  private readonly holdersByLine = new Map<string, Set<string>>();

  /** entity → the facts recorded for it. */
  private readonly factsByEntity = new Map<string, PhoneFacts>();

  /** last-ten → stated E.164 → people stating it. */
  private readonly statedByLine = new Map<string, Map<string, Set<string>>>();

  /** last-ten → stated E.164 forms `ci.identifier_claims` carries. Fixed for the holder's life. */
  private readonly claimStatedByLine = new Map<string, Set<string>>();

  /** Entities recorded as the owner. */
  private readonly selfIds = new Set<string>();

  constructor(
    facts: Iterable<readonly [string, PhoneFacts]> = [],
    claimStated: Iterable<readonly [string, string]> = [],
  ) {
    for (const [line, e164] of claimStated) {
      const forms = this.claimStatedByLine.get(line) ?? new Set<string>();
      forms.add(e164);
      this.claimStatedByLine.set(line, forms);
    }

    for (const [entityId, fact] of facts) {
      this.set(entityId, fact);
    }
  }

  /** Record what `entityId` states NOW, replacing whatever it stated before. */
  set(entityId: string, facts: PhoneFacts): void {
    this.delete(entityId);

    if (facts.lines.size === 0) {
      return;
    }

    this.factsByEntity.set(entityId, facts);

    if (facts.isSelf) {
      this.selfIds.add(entityId);
    }

    for (const [line, reading] of facts.lines) {
      const holders = this.holdersByLine.get(line) ?? new Set<string>();
      holders.add(entityId);
      this.holdersByLine.set(line, holders);

      for (const e164 of reading.stated) {
        const forms = this.statedByLine.get(line) ?? new Map<string, Set<string>>();
        const statedBy = forms.get(e164) ?? new Set<string>();
        statedBy.add(entityId);
        forms.set(e164, statedBy);
        this.statedByLine.set(line, forms);
      }
    }
  }

  /** `entityId` holds nothing any more: merged away, deactivated or deleted. */
  delete(entityId: string): void {
    const facts = this.factsByEntity.get(entityId);

    if (facts == null) {
      return;
    }

    this.factsByEntity.delete(entityId);
    this.selfIds.delete(entityId);

    for (const [line, reading] of facts.lines) {
      const holders = this.holdersByLine.get(line);
      holders?.delete(entityId);

      if (holders?.size === 0) {
        this.holdersByLine.delete(line);
      }

      const forms = this.statedByLine.get(line);

      for (const e164 of reading.stated) {
        const statedBy = forms?.get(e164);
        statedBy?.delete(entityId);

        if (statedBy?.size === 0) {
          forms?.delete(e164);
        }
      }

      if (forms?.size === 0) {
        this.statedByLine.delete(line);
      }
    }
  }

  /** Everyone whose record carries these last ten digits. */
  holdersOf(line: string): string[] {
    return [...(this.holdersByLine.get(line) ?? [])];
  }

  /** True when more than {@link PHONE_MAX_HOLDERS} people carry these digits. */
  isOverCommon(line: string): boolean {
    return (this.holdersByLine.get(line)?.size ?? 0) > PHONE_MAX_HOLDERS;
  }

  /** Every last-ten the owner's own record carries. Never evidence between two contacts. */
  ownerLines(): Set<string> {
    const lines = new Set<string>();

    for (const id of this.selfIds) {
      for (const line of this.factsByEntity.get(id)?.lines.keys() ?? []) {
        lines.add(line);
      }
    }

    return lines;
  }

  /**
   * True when anything in the corpus — a person's `Phones`, a numeric display
   * name, an identifier claim's `value_e164` — states these digits as a
   * number OTHER than `e164`. The inferred reading then yields: a Google
   * Voice export that stripped `+44` from a number is not a US number because
   * its last ten digits happen to look like one.
   */
  foreignStated(line: string, e164: string): boolean {
    for (const form of this.statedByLine.get(line)?.keys() ?? []) {
      if (form !== e164) {
        return true;
      }
    }

    for (const form of this.claimStatedByLine.get(line) ?? []) {
      if (form !== e164) {
        return true;
      }
    }

    return false;
  }

  /** The facts recorded for `entityId`, if it holds any line. */
  factsOf(entityId: string): PhoneFacts | undefined {
    return this.factsByEntity.get(entityId);
  }

  /**
   * What one person's record says these digits are, with the corpus in view.
   * In order:
   *
   *  0. Digits the record files as a FAX are refused outright, ahead of any
   *     stated form: the same digits in a phone key (the vCard identity key
   *     can be the fax) do not make office equipment a personal line.
   *  1. One stated form wins; two that disagree leave the country unconfirmed.
   *  2. A REFUSED raw value beats an inferred reading of the same digits. The
   *     lower-case `phones`/`phone` keys are the importer's last-ten of the
   *     raw value, so when the raw value is a UK national number ("020 7946
   *     0958") or carries an extension, the key is a truncation of something
   *     that is not a North American number, and reading it as one is exactly
   *     the collision this module exists to prevent.
   *  3. An inferred reading the corpus states under another country
   *     ({@link foreignStated}) is unconfirmed; otherwise it is the number.
   *  4. No region: unconfirmed.
   */
  resolve(facts: PhoneFacts, line: string): PhoneReading {
    const reading = facts.lines.get(line);

    if (reading == null) {
      return { kind: 'refused', reasons: ['invalid'] };
    }

    if (reading.refused.has('fax')) {
      return { kind: 'refused', reasons: ['fax'] };
    }

    if (reading.stated.size > 1) {
      return { kind: 'unconfirmed' };
    }

    if (reading.stated.size === 1) {
      return { kind: 'number', e164: [...reading.stated][0], stated: true };
    }

    const refusals = [...reading.refused].filter((status) => status !== 'no_region');

    if (refusals.length > 0) {
      return { kind: 'refused', reasons: [...new Set(refusals.map(refusalReason))].sort() };
    }

    if (reading.inferred != null) {
      return this.foreignStated(line, reading.inferred)
        ? { kind: 'unconfirmed' }
        : { kind: 'number', e164: reading.inferred, stated: false };
    }

    return { kind: 'unconfirmed' };
  }

  /**
   * How many distinct real identities carry `e164`, and whether any holder of
   * it could be more than one of them.
   *
   * Counted over the holders of its digits who read them as this number or
   * cannot say, plus `pair` — the people being judged, so a verdict never
   * depends on whether its caller recorded them. A placeholder is nobody in
   * particular and is not counted; a holder with no usable given name (a lone
   * surname, a relational name, a number that is not its own) is an identity
   * of its own. `pair` adds named people only: a recorded one counted twice
   * is harmless, because a name may be one person with itself.
   *
   * Two named holders MAY BE ONE PERSON exactly when {@link givenNameRelation}
   * would let a pair of them fold — `same` or `initial`. Whatever it holds
   * back (a different given name, a prefix, a family-name conflict, a Jr/Sr
   * mismatch) is two identities here too, so the census never counts as one
   * person two holders the adjudicator itself says are two: "Ada Quill" and
   * "Ada Brightwater" on one office line are two Adas, and the same goes for
   * "A. Quill" and "A. Brightwater".
   *
   * A holder that may be one person with each of two holders who may NOT be —
   * a bare "Ada" or an "Ada Q." beside those two Adas, an "A." beside "Ada"
   * and "Abe" — could be either of them, and makes the line `ambiguous`. Among
   * the holders that are not, "may be one person" is transitive (a failure of
   * transitivity IS such a holder), so the identities are its classes.
   *
   * An initial that starts two different full given names on the line makes
   * it `ambiguous` as well, whether or not it folds with both. Folding is
   * deliberately narrow — a Jr/Sr on one side only, or a different surname,
   * holds a pair for review — and a pair held for review is not proven to be
   * two people: an "A." beside "Abe Quill" and "Ada Quill Sr." folds with Abe
   * alone, yet may still be that Ada. By classes alone that line holds two
   * identities, and a same-given pair on it would grade exact.
   */
  lineCensus(
    line: string,
    e164: string,
    pair: readonly PhoneFacts[] = [],
  ): { identities: number; ambiguous: boolean } {
    const named: PhoneFacts[] = pair.filter(hasCensusName);
    let unnamed = 0;

    for (const id of this.holdersOf(line)) {
      const facts = this.factsByEntity.get(id);

      if (facts == null || facts.placeholder != null) {
        continue;
      }

      const reading = this.resolve(facts, line);

      if (reading.kind === 'refused' || (reading.kind === 'number' && reading.e164 !== e164)) {
        continue;
      }

      if (hasCensusName(facts)) {
        named.push(facts);
      } else {
        unnamed += 1;
      }
    }

    const fits = named.map((a) =>
      named.map((b) => ONE_PERSON_RELATIONS.has(relateNames(a.name, b.name, a.rawName, b.rawName))),
    );
    const bridging = named.map((_, h) =>
      named.some(
        (_a, a) =>
          a !== h && fits[h][a] && named.some((_b, b) => b !== h && b !== a && fits[h][b] && !fits[a][b]),
      ),
    );
    const givens = named.flatMap((facts) => censusGiven(facts) ?? []);
    const fullGivens = new Set(givens.filter((given) => given.length > 1));
    const initialFitsTwo = givens.some(
      (given) => given.length === 1 && [...fullGivens].filter((full) => full.startsWith(given)).length > 1,
    );
    const ambiguous = bridging.includes(true) || initialFitsTwo;
    const classes: number[] = [];

    named.forEach((_, index) => {
      if (!bridging[index] && !classes.some((representative) => fits[index][representative])) {
        classes.push(index);
      }
    });

    // Either kind of ambiguity stands between two people who cannot be one: at least two identities.
    return { identities: (ambiguous ? Math.max(classes.length, 2) : classes.length) + unnamed, ambiguous };
  }

  /**
   * Judge two people's phone facts. Symmetric in its verdict kind; `left` and
   * `right` in a conflict follow the argument order.
   */
  adjudicate(left: PhoneFacts, right: PhoneFacts): PhoneVerdict {
    const shared = [...left.lines.keys()].filter((line) => right.lines.has(line)).sort();

    if (shared.length === 0) {
      return { kind: 'absent' };
    }

    const selfEndpoint = left.isSelf || right.isSelf;
    const ownerLines = selfEndpoint ? new Set<string>() : this.ownerLines();
    const equal: Array<{ line: string; e164: string; stated: number }> = [];
    const conflicts: Array<{ left: string; right: string }> = [];
    const unconfirmed: string[] = [];
    const unusable = new Set<PhoneUnusableReason>();

    for (const line of shared) {
      if (ownerLines.has(line)) {
        unusable.add('owner_number');
        continue;
      }

      if (this.isOverCommon(line)) {
        unusable.add('over_common');
        continue;
      }

      const a = this.resolve(left, line);
      const b = this.resolve(right, line);

      if (a.kind === 'refused' || b.kind === 'refused') {
        for (const reading of [a, b]) {
          if (reading.kind === 'refused') {
            reading.reasons.forEach((reason) => unusable.add(reason));
          }
        }

        continue;
      }

      if (a.kind === 'number' && b.kind === 'number') {
        if (a.e164 === b.e164) {
          equal.push({ line, e164: a.e164, stated: Number(a.stated) + Number(b.stated) });
        } else {
          conflicts.push({ left: a.e164, right: b.e164 });
        }

        continue;
      }

      unconfirmed.push(line);
    }

    if (conflicts.length > 0) {
      return { kind: 'country_conflict', conflicts };
    }

    if (equal.length > 0) {
      return this.grade(left, right, equal, selfEndpoint);
    }

    if (unconfirmed.length > 0) {
      return { kind: 'unconfirmed', digits: unconfirmed };
    }

    return { kind: 'unusable', reasons: [...unusable].sort() };
  }

  private grade(
    left: PhoneFacts,
    right: PhoneFacts,
    equal: ReadonlyArray<{ line: string; e164: string; stated: number }>,
    selfEndpoint: boolean,
  ): PhoneVerdict {
    const numbers = [...new Set(equal.map((item) => item.e164))].sort();
    const reasons: PhoneCheckReason[] = [];

    if (selfEndpoint) {
      reasons.push('self_endpoint');
    }

    let relation: GivenNameRelation | 'placeholder';

    if (left.nameIsOtherNumber || right.nameIsOtherNumber) {
      reasons.push('numeric_name_mismatch');
      relation = 'unknown';
    } else if (left.placeholder != null || right.placeholder != null) {
      relation = 'placeholder';
    } else {
      relation = givenNameRelation(left.rawName, right.rawName);
    }

    const compatible = relation === 'placeholder' || relation === 'same' || relation === 'initial';

    if (!compatible && !reasons.includes('numeric_name_mismatch')) {
      reasons.push(RELATION_REASON[relation]);
    }

    const passing = compatible
      ? equal.filter(({ line, e164 }) => {
          const census = this.lineCensus(line, e164, [left, right]);
          const limit = relation === 'same' ? PHONE_LINE_MAX_IDENTITIES : 1;

          return !census.ambiguous && census.identities <= limit;
        })
      : [];

    if (compatible && passing.length === 0) {
      reasons.push('shared_line');
    }

    if (reasons.length > 0) {
      return { kind: 'review', numbers, reasons };
    }

    const best = Math.max(...passing.map((item) => item.stated));
    const basis: PhoneBasis = best === 2 ? 'stated_both' : best === 1 ? 'stated_one' : 'inferred_both';

    return { kind: 'exact', numbers: [...new Set(passing.map((item) => item.e164))].sort(), basis };
  }
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/**
 * One row of {@link PHONE_FACTS_CORPUS_SQL}: a live Person's name, self flag
 * and the fields {@link extractPhoneFacts} reads.
 */
export interface PhoneFactsCorpusRow {
  entity_id: string;
  person_name: string | null;
  phone_props: Record<string, unknown> | null;
  is_self: boolean | null;
}

/** One row of {@link PHONE_CLAIM_E164_SQL}. */
export interface PhoneClaimE164Row {
  l10: string;
  e164: string;
}

/**
 * The corpus read once: the owner's region (derived from the corpus itself,
 * see {@link derivePhoneRegion}) and every live person's facts in it. Both
 * callers go through this, so the region and the facts mean the same thing at
 * detection and at merge time.
 */
export function phoneCorpusFacts(
  rows: readonly PhoneFactsCorpusRow[],
  owner: { timezone: string | null | undefined; selfEntityId: string | null | undefined },
): { region: PhoneRegion | null; facts: Map<string, PhoneFacts> } {
  const isSelf = (row: PhoneFactsCorpusRow) => row.is_self === true || row.entity_id === owner.selfEntityId;
  const statedNumbers: string[] = [];
  const selfStatedNumbers: string[] = [];

  for (const row of rows) {
    const stated = statedPhoneNumbers(row.phone_props, row.person_name);
    statedNumbers.push(...stated);

    if (isSelf(row)) {
      selfStatedNumbers.push(...stated);
    }
  }

  const region = derivePhoneRegion({ selfStatedNumbers, timezone: owner.timezone, statedNumbers });
  const facts = new Map<string, PhoneFacts>();

  for (const row of rows) {
    const extracted = extractPhoneFacts(row.phone_props, row.person_name, isSelf(row), region);

    if (extracted.lines.size > 0) {
      facts.set(row.entity_id, extracted);
    }
  }

  return { region, facts };
}

/** Last-tens carried by two or more people — the only ones worth asking the claims table about. */
export function sharedPhoneLines(facts: ReadonlyMap<string, PhoneFacts>): string[] {
  const counts = new Map<string, number>();

  for (const fact of facts.values()) {
    for (const line of fact.lines.keys()) {
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }

  return [...counts].filter(([, count]) => count > 1).map(([line]) => line);
}

// ---------------------------------------------------------------------------
// Verdict → evidence
// ---------------------------------------------------------------------------

/** One evidence item as `ci.merge_candidates.evidence` stores it. */
export interface PhoneEvidenceItem {
  kind: string;
  value: string;
  score: number;
}

/** Any evidence item — the detector's (numeric score) or one parsed back from a row (nullable). */
interface PhoneEvidenceLike {
  kind: string;
  value: string;
  score: number | null;
}

/** The items a verdict contributes. Markers carry score 0: they inform, they never weigh. */
export function phoneEvidenceFor(verdict: PhoneVerdict): PhoneEvidenceItem[] {
  switch (verdict.kind) {
    case 'absent':
    case 'unusable':
      return [];
    case 'exact':
      return [
        { kind: PHONE_EVIDENCE.match, value: verdict.numbers.join(', '), score: PHONE_IDENTITY_SCORES.exact },
      ];
    case 'review':
      return [
        {
          kind: PHONE_EVIDENCE.match,
          value: verdict.numbers.join(', '),
          score: PHONE_IDENTITY_SCORES.review,
        },
        { kind: PHONE_EVIDENCE.check, value: verdict.reasons.join(', '), score: 0 },
      ];
    case 'unconfirmed':
      return [
        {
          kind: PHONE_EVIDENCE.match,
          value: verdict.digits.join(', '),
          score: PHONE_IDENTITY_SCORES.unconfirmed,
        },
      ];
    case 'country_conflict':
      return [
        {
          kind: PHONE_EVIDENCE.conflict,
          value: verdict.conflicts.map(({ left, right }) => `${left} ≠ ${right}`).join('; '),
          score: 0,
        },
      ];
  }
}

function rescore<E extends PhoneEvidenceLike>(evidence: E[]): { score: number; evidence: E[] } {
  evidence.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.kind.localeCompare(b.kind));

  return { score: Math.max(0, ...evidence.map((item) => item.score ?? 0)), evidence };
}

/**
 * Hold every phone item at or above the exact tier that the adjudicator did
 * not write down to {@link PHONE_IDENTITY_SCORES.review}, marked
 * `unadjudicated`. The claim pass can still score an E.164-equal claim pair
 * 0.95 with no name guard at all; this is what stops that from reaching the
 * auto-merger. Idempotent, and a no-op for a candidate with no such item.
 */
export function capUnadjudicatedPhones<E extends PhoneEvidenceLike>(candidate: {
  readonly score: number;
  readonly evidence: readonly E[];
}): { score: number; evidence: Array<E | PhoneEvidenceItem> } {
  const strong = (item: PhoneEvidenceLike) =>
    item.kind === PHONE_EVIDENCE.match && (item.score ?? 0) >= PHONE_IDENTITY_SCORES.exact;

  if (!candidate.evidence.some(strong)) {
    return { score: candidate.score, evidence: [...candidate.evidence] };
  }

  const evidence: Array<E | PhoneEvidenceItem> = candidate.evidence.map((item) =>
    strong(item) ? { ...item, score: PHONE_IDENTITY_SCORES.review } : item,
  );
  const check = evidence.findIndex((item) => item.kind === PHONE_EVIDENCE.check);

  if (check === -1) {
    evidence.push({ kind: PHONE_EVIDENCE.check, value: 'unadjudicated', score: 0 });
  } else if (!evidence[check].value.split(', ').includes('unadjudicated')) {
    evidence[check] = { ...evidence[check], value: `${evidence[check].value}, unadjudicated` };
  }

  return rescore(evidence);
}

/**
 * Re-state a candidate's phone evidence under `verdict`, and rescore it.
 *
 * Every existing phone item (match, check and conflict) is removed first, so
 * the result depends only on the verdict — applying it twice is applying it
 * once, and a stale item from an earlier adjudication, or the claim pass's
 * unguarded one, can never survive a new verdict. The score is the strongest
 * weighed item, exactly as the detector scores any pair; a pair whose only
 * evidence was an unusable number is left with nothing (score 0).
 *
 * An `absent` verdict re-states nothing — there were no shared digits to
 * judge — and only applies {@link capUnadjudicatedPhones}.
 *
 * Run BEFORE `applyProfileVerdict`: its partial/conflict cap must be the last
 * word on the score.
 */
export function applyPhoneVerdict<E extends PhoneEvidenceLike>(
  candidate: { readonly score: number; readonly evidence: readonly E[] },
  verdict: PhoneVerdict,
): { score: number; evidence: Array<E | PhoneEvidenceItem> } {
  if (verdict.kind === 'absent') {
    return capUnadjudicatedPhones(candidate);
  }

  return rescore<E | PhoneEvidenceItem>([
    ...candidate.evidence.filter((item) => !isPhoneEvidenceKind(item.kind)),
    ...phoneEvidenceFor(verdict),
  ]);
}

// ---------------------------------------------------------------------------
// Re-checking stored evidence
// ---------------------------------------------------------------------------

/**
 * The last-tens one person's record carries as a line of theirs — every line
 * the record does not itself refuse. A fax is office equipment, and an
 * extension, a short code or an invalid value names no line at all; a stated
 * form wins over a refusal of the same digits elsewhere on the record, as in
 * {@link PhoneHolders.resolve}. A national value the owner's region would
 * read as a number (`no_region` without one) is carried whatever its reading:
 * this answers "is the number on the record", not "is it good evidence".
 *
 * Needs no corpus — read the facts with any region, `null` included.
 */
export function carriedPhoneLines(facts: PhoneFacts): Set<string> {
  const carried = new Set<string>();

  for (const [line, reading] of facts.lines) {
    if (reading.refused.has('fax')) {
      continue;
    }

    const refusals = [...reading.refused].filter((status) => status !== 'no_region');

    if (reading.stated.size > 0 || reading.inferred != null || refusals.length === 0) {
      carried.add(line);
    }
  }

  return carried;
}

/** What the live records still support, for {@link revalidatePhoneEvidence}. */
export interface LivePhoneSupport {
  /**
   * Last-tens BOTH people still carry: each one's own record
   * ({@link carriedPhoneLines}), and the numbers each was OBSERVED with —
   * live, non-rejected claims from the linkers, NOT self claims, which are
   * copies of the record that nothing retracts. A stored number outside this
   * set is a number one of the two people no longer has.
   */
  carried: ReadonlySet<string>;
  /**
   * Hold what survives below the auto-merge tier, marked `unadjudicated`
   * ({@link capUnadjudicatedPhones}). The drain sets it when the two records no
   * longer share any number (verdict `absent`), so what is left stands on
   * observed claims alone — exactly the claim pass's evidence, which the
   * detector holds the same way. Default false: the review queue's check
   * asks only whether the numbers are still there, and leaves grading to the
   * detector and the drain.
   */
  capUnadjudicated?: boolean;
}

/** A re-checked candidate: its evidence and score now, and whether either moved. */
export interface RevalidatedPhoneEvidence<E> {
  score: number;
  evidence: Array<E | PhoneEvidenceItem>;
  changed: boolean;
}

/** The last-ten join key of one number as evidence writes it: E.164, national, or bare digits. */
function evidenceLine(value: string): string {
  return lastTen(value.replace(/\D/g, ''));
}

/** The numbers one phone evidence item names — every writer joins several with `, `. */
export function phoneEvidenceNumbers(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => evidenceLine(part).length > 0);
}

/**
 * Re-check a STORED candidate's phone evidence against the live records, and
 * take out whatever no longer holds.
 *
 * ── Why stored evidence goes stale ─────────────────────────────────────────
 *
 * `clean.duplicate_detect` writes a pair once per scoring generation and never
 * withdraws one, and the ledger does not re-open a person when their record
 * changes — only a version bump does. Between sweeps a re-import rewrites
 * `properties` from that source's own card (dropping the numbers a merge
 * folded in), a merge moves numbers, a user edits a contact, and a card can
 * come to file a number as its office fax. The review queue then shows "Same
 * phone number" over a number one of the two people no longer carries.
 *
 * ── Subtractive, on purpose ─────────────────────────────────────────────────
 *
 * This removes; it never adds a number and never raises a score. A phone item
 * keeps exactly the numbers both people still carry ({@link LivePhoneSupport})
 * and is dropped when none are left; a `phone_check` goes with the last match
 * it explained; a `phone_country_conflict` stays while both still carry its
 * digits. The new score is the strongest item left, capped at the stored score
 * so a profile-URL veto's cap survives. Finding NEW evidence, or re-grading
 * old evidence (a number since become over-common, or the owner's), is the
 * detector's job on its next sweep, and folding an exact pair is the drain's,
 * after its own live re-check.
 *
 * `changed` is false exactly when every stored item still holds, and the
 * candidate is then returned as it was.
 */
export function revalidatePhoneEvidence<E extends PhoneEvidenceLike>(
  candidate: { readonly score: number; readonly evidence: readonly E[] },
  live: LivePhoneSupport,
): RevalidatedPhoneEvidence<E> {
  let changed = false;
  let matched = false;
  const kept: Array<E | PhoneEvidenceItem> = [];

  for (const item of candidate.evidence) {
    if (item.kind === PHONE_EVIDENCE.conflict) {
      // "Same digits, two countries": it holds while both still carry them.
      const digits = phoneEvidenceNumbers(item.value.replace(/≠|;/g, ',')).map(evidenceLine);

      if (digits.length > 0 && digits.every((line) => live.carried.has(line))) {
        kept.push(item);
      } else {
        changed = true;
      }

      continue;
    }

    if (item.kind !== PHONE_EVIDENCE.match) {
      kept.push(item);
      continue;
    }

    const numbers = phoneEvidenceNumbers(item.value);
    const holding = numbers.filter((number) => live.carried.has(evidenceLine(number)));

    if (holding.length === 0) {
      changed = true;
      continue;
    }

    matched = true;

    if (holding.length === numbers.length) {
      kept.push(item);
    } else {
      changed = true;
      kept.push({ ...item, value: holding.join(', ') });
    }
  }

  const evidence = kept.filter((item) => item.kind !== PHONE_EVIDENCE.check || matched);

  if (evidence.length !== kept.length) {
    changed = true;
  }

  const capped = live.capUnadjudicated
    ? capUnadjudicatedPhones({ score: candidate.score, evidence })
    : { score: candidate.score, evidence };

  if (capped.evidence.length !== evidence.length || capped.evidence.some((item, i) => item !== evidence[i])) {
    changed = true;
  }

  if (!changed) {
    return { score: candidate.score, evidence: [...candidate.evidence], changed: false };
  }

  const rescored = rescore(capped.evidence);

  return { score: Math.min(candidate.score, rescored.score), evidence: rescored.evidence, changed: true };
}

// ---------------------------------------------------------------------------
// SQL text — no access, only construction
// ---------------------------------------------------------------------------

/**
 * A `jsonb_build_object(...)` of exactly the keys {@link extractPhoneFacts}
 * reads, so a caller loads the few fields that matter rather than the whole
 * `properties` bag.
 */
export function phoneFactsSqlObject(alias: string): string {
  return `jsonb_build_object(${FACT_SQL_KEYS.map((key) => `'${key}', ${alias}.properties->'${key}'`).join(
    ', ',
  )})`;
}

/**
 * Every live Person of the owner bound to `$1` that carries a phone value or
 * whose display name is letterless and has digits, with only the fields
 * {@link extractPhoneFacts} reads and the self flag.
 *
 * The population {@link PhoneHolders} counts over. The detector and the
 * auto-merger both load it with THIS text, so the holder cap, the owner's
 * lines and the line census mean the same thing at detection and at merge
 * time. The name test is a superset prefilter (`[[:alpha:]]` is
 * locale-dependent); {@link classifyPhoneName} decides.
 */
export const PHONE_FACTS_CORPUS_SQL = `SELECT e.entity_id,
              e.name AS person_name,
              ${phoneFactsSqlObject('e')} AS phone_props,
              (e.is_self IS TRUE OR e.properties->>'is_self' = 'true') AS is_self
         FROM ci.entities e
        WHERE e.owner_user_id = $1::uuid
          AND e.entity_type = 'Person'
          AND COALESCE(e.is_active, true) = true
          AND e.merged_into_entity_id IS NULL
          AND (e.properties ?| array[${FACT_SQL_KEYS.map((key) => `'${key}'`).join(', ')}]
               OR (e.name !~ '[[:alpha:]]' AND e.name ~ '[0-9]'))`;

/**
 * The stated E.164 forms identifier claims carry for the last-tens bound to
 * `$2` (owner `$1`) — the claims half of {@link PhoneHolders.foreignStated}.
 * Rejected claims are a human's "this is not theirs" and are not read. Rides
 * `identifier_claims_lookup_idx` (owner, kind, value_normalized).
 */
export const PHONE_CLAIM_E164_SQL = `SELECT c.value_normalized AS l10, c.value_e164 AS e164
         FROM ci.identifier_claims c
        WHERE c.owner_user_id = $1::uuid
          AND c.kind = 'phone'
          AND c.value_normalized = ANY($2::text[])
          AND c.value_e164 IS NOT NULL
          AND c.disposition IS DISTINCT FROM 'rejected'
        GROUP BY c.value_normalized, c.value_e164`;
