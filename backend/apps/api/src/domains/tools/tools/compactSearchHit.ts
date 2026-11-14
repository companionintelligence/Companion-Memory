/**
 * A search hit as a model should read it: what the entity is, when, and what it says, without the
 * rest of its row.
 *
 * A hit used to be the hydrated entity spread whole, so every one of them carried every column
 * of its table: `userId`, `deviceId`, `connectionId`, `sourceId`, `null` scores, `false` flags,
 * `[]` and `{}`, foreign-key UUIDs, and the full body of an email with every tracking URL in it.
 * Measured 2026-11-13 from OpenClaw over MCP: a `knowledge_search` page of three emails was
 * 25,670 characters, which OpenClaw cut to 15.5k, and four searches in two questions overflowed
 * a 64k window. The in-app chat bounds a result on its way into the prompt
 * (`llm/toolResultBudget.ts`) and the phone shapes it again (`ToolResultShaper.kt`), but MCP and
 * REST callers get exactly what the tool returns, so the trimming belongs here, once.
 *
 * The rules are the phone shaper's prune, so the three agree on what a hit is:
 * - `null`, `""`, `false`, `[]` and `{}` go: an unset column tells the model nothing.
 * - A string that is a bare UUID goes, except `id`: a foreign key (`threadId`, `fromEntityId`) is
 *   something no model can read. `id` stays, unlike on the phone, because MCP callers have
 *   intents that take one (`memory_forget`, `planning_updateTask`, `people_relationships`).
 * - {@link BOOKKEEPING_KEYS} go at every depth: provenance and storage columns no question asks.
 * - A long URL inside text becomes its host (`https://calendar.google.com/…`): email bodies are
 *   mostly tracking and unsubscribe links, each a few hundred characters of signature.
 * - Runs of blank lines collapse, and every string is capped at `stringCap` characters with a
 *   note of how much was cut. The cap is shared out across the page ({@link stringCapFor}), so
 *   one hit can be read nearly whole while a page of ten each gets a paragraph.
 *
 * `link` is the way to the rest: the prompt tells the model to hand it to the user.
 */

/** Columns that are provenance or storage, at any depth (`metadata` repeats several). */
const BOOKKEEPING_KEYS: ReadonlySet<string> = new Set([
  'userId',
  'user_id',
  'ownerUserId',
  'owner_user_id',
  'connectionId',
  'connection_id',
  'deviceId',
  'sourceId',
  'sourceType',
  'externalId',
  'externalIdKind',
  'captureTickId',
  'rawEventId',
  'linkedTable',
  'linkedId',
  'searchContent',
  'updatedAt',
  'timeSource',
  'timePrecision',
  'confidenceScore',
]);

/** Containers deeper than this are dropped; a real hit nests three or four levels. */
const MAXIMUM_DEPTH = 6;

/** Elements an array inside a hit keeps (participants, attachments, addresses). */
const MAXIMUM_ARRAY_ELEMENTS = 10;

/** The page's whole string allowance, shared out per hit by {@link stringCapFor}. */
const PAGE_STRING_BUDGET = 6_000;
const MINIMUM_STRING_CAP = 300;
const MAXIMUM_STRING_CAP = 4_000;

/** A URL longer than this inside text is shortened to its origin. */
const LONG_URL_LENGTH = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"')\]]+/g;

/** How long each string of a hit may be on a page of `hitCount` hits. */
export function stringCapFor(hitCount: number): number {
  const share = Math.floor(PAGE_STRING_BUDGET / Math.max(1, hitCount));

  return Math.min(MAXIMUM_STRING_CAP, Math.max(MINIMUM_STRING_CAP, share));
}

function shortenUrls(text: string): string {
  return text.replace(URL_IN_TEXT, (url) => {
    if (url.length <= LONG_URL_LENGTH) {
      return url;
    }

    try {
      return `${new URL(url).origin}/…`;
    } catch {
      return url;
    }
  });
}

function compactString(value: string, stringCap: number): string | undefined {
  const text = shortenUrls(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (text.length === 0) {
    return undefined;
  }

  if (text.length <= stringCap) {
    return text;
  }

  return `${text.slice(0, stringCap)}…[${text.length - stringCap} more characters; open the link for the rest]`;
}

function compactValue(value: unknown, stringCap: number, depth: number): unknown {
  if (value == null || value === false) {
    return undefined;
  }

  if (typeof value === 'string') {
    return UUID.test(value) ? undefined : compactString(value, stringCap);
  }

  if (typeof value !== 'object') {
    return value;
  }

  // A Date (or anything else that serializes through toJSON) is written the way JSON.stringify
  // would write it; walking its entries would flatten it to `{}`.
  const toJson = (value as { toJSON?: unknown }).toJSON;

  if (typeof toJson === 'function') {
    return compactValue((toJson as () => unknown).call(value), stringCap, depth);
  }

  if (depth >= MAXIMUM_DEPTH) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const kept = value
      .map((element) => compactValue(element, stringCap, depth + 1))
      .filter((element) => element !== undefined);

    if (kept.length === 0) {
      return undefined;
    }

    if (kept.length > MAXIMUM_ARRAY_ELEMENTS) {
      return [...kept.slice(0, MAXIMUM_ARRAY_ELEMENTS), `…and ${kept.length - MAXIMUM_ARRAY_ELEMENTS} more`];
    }

    return kept;
  }

  const out: Record<string, unknown> = {};

  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (BOOKKEEPING_KEYS.has(key)) {
      continue;
    }

    const kept = compactValue(member, stringCap, depth + 1);

    if (kept !== undefined) {
      out[key] = kept;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * One hit, trimmed. `id`, `type`, `link` and `takenAt` are written first and kept as they are:
 * they are what identifies the hit and what the model may copy.
 */
export function compactSearchHit<T extends { id: string; type: string; link?: string; takenAt?: string }>(
  hit: T,
  stringCap: number,
): CompactSearchHit<T['type']> {
  const { id, type, link, takenAt, ...rest } = hit;
  const body = (compactValue(rest, stringCap, 0) as Record<string, unknown> | undefined) ?? {};

  return {
    id,
    type,
    ...(link ? { link } : {}),
    ...(takenAt ? { takenAt } : {}),
    ...body,
  };
}

/**
 * The most a page of hits may take, in characters of compact JSON. Measured 2026-11-13: with only
 * the per-hit trim, a 25-hit page was still 17k characters, and an OpenClaw chat at a 64k window
 * (a 45.5k-token budget, ~26k of it the fixed prompt) overflowed on its second question.
 */
export const PAGE_CHARACTER_BUDGET = 8_000;

/** Strings are shortened this far, and no further, before hits are left out instead. */
const SMALLEST_SHRUNK_CAP = 120;

/**
 * A page of hits, trimmed to fit {@link PAGE_CHARACTER_BUDGET}: strings shorten step by step
 * (a hit's identity and dates never do), and if the shortest still overflows, trailing hits are
 * left out. `omitted` counts those, so the caller can say the page was cut. The first hit is
 * always kept.
 */
export function boundSearchPage<T extends { id: string; type: string; link?: string; takenAt?: string }>(
  hits: readonly T[],
  budget: number = PAGE_CHARACTER_BUDGET,
): { items: CompactSearchHit<T['type']>[]; omitted: number } {
  let cap = stringCapFor(hits.length);
  let items = hits.map((hit) => compactSearchHit(hit, cap));

  while (JSON.stringify(items).length > budget && cap > SMALLEST_SHRUNK_CAP) {
    cap = Math.max(SMALLEST_SHRUNK_CAP, Math.floor(cap * 0.6));
    items = hits.map((hit) => compactSearchHit(hit, cap));
  }

  const kept: CompactSearchHit<T['type']>[] = [];
  let spent = 2;

  for (const item of items) {
    const cost = JSON.stringify(item).length + (kept.length > 0 ? 1 : 0);

    if (kept.length > 0 && spent + cost > budget) {
      break;
    }

    kept.push(item);
    spent += cost;
  }

  return { items: kept, omitted: items.length - kept.length };
}

/** A trimmed hit: its identity, then whichever of its entity's fields had something to say. */
export type CompactSearchHit<TType extends string = string> = {
  id: string;
  type: TType;
  link?: string;
  takenAt?: string;
} & Record<string, unknown>;
