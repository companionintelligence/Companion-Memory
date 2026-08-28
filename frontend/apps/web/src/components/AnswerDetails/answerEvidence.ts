/**
 * The ONE place that says what the answer-details drawer needs from an answer
 * record, and the only place that reads it off the wire.
 *
 * Why a normaliser instead of a generated type: the structured evidence the
 * backend attaches to an inferred answer is being added in parallel with this
 * UI, so its field names are not settled. Everything below is therefore read
 * DEFENSIVELY — the drawer depends on {@link AnswerCitation}, which is ours,
 * and `readAnswerCitations` is the single seam where a wire name is spelled
 * out. When the API shape lands, the aliases here collapse to whatever it
 * actually sends and nothing else in the frontend moves.
 *
 * Absence is a normal answer, not a failure: an answer written before evidence
 * was recorded, and every answer a person typed themselves, genuinely has no
 * citations. `readAnswerCitations` returns `[]` for all of it — undefined,
 * null, a string, a number, an empty array, an array of junk — and the drawer
 * renders the empty state rather than an error.
 */

/**
 * Who produced one piece of evidence. Mirrors `EvidenceVoice` in
 * `backend/apps/api/src/domains/agent/types.ts`, and it is the distinction the
 * drawer exists to preserve: an INBOUND message is somebody else's words that
 * merely arrived in the archive, and must never be read back as a statement
 * the owner made about themselves.
 *
 * `null` is a third state here that the backend does not have: it means this
 * citation did not say, so the UI must not claim either way.
 */
export type EvidenceVoice = 'own' | 'other';

/**
 * The wrapper exactly as the API sends it, mirroring `AnswerEvidence` in
 * `backend/apps/api/src/domains/intelligence/types.ts`.
 *
 * Declared here — and referenced by the REST wire types in
 * `pages/PromptsPage/catalogue.ts` and `pages/PromptsPage/PromptsPage.tsx` — so
 * the seam is held by the compiler and not only by the tolerant reader below.
 * If the backend renames `citations`, `evidence` or `answerEvidence`, those
 * call sites stop compiling; without the declaration the rename would land as
 * a drawer that quietly shows no evidence, which is the one failure mode this
 * feature cannot afford.
 *
 * Every field is optional on the way in: this is read back out of a jsonb
 * column, so a row written by an older build can be missing anything, and the
 * reader below is what actually copes with that.
 */
export interface AnswerEvidenceWire {
  citations?: unknown;
  /**
   * The rows the model was SHOWN and did not name, same shape as `citations`.
   *
   * Optional in the strong sense: absent and empty mean different things and
   * the drawer says different things about them. Absent = this answer predates
   * the field, its unused lines were never kept, and nothing may claim the list
   * is complete. Empty = the model named every line it was shown.
   */
  uncited?: unknown;
  linesShown?: number | null;
  linesOwn?: number | null;
  model?: string | null;
}

/**
 * One database object an inferred answer was grounded in.
 *
 * Maps `AnswerEvidenceCitation` on the API (`{ line, type, id, at, voice,
 * snippet }`) onto the names this UI uses, and stays tolerant of the aliases
 * below so a row written by an older or newer build still renders.
 */
export interface AnswerCitation {
  /** Stable-within-a-render React key. Never sent by the API; built here. */
  key: string;
  /** `communication`, `event`, `content`… — whatever the row's table/entity is. */
  type: string | null;
  /** The row's own id, when the API sent one. Display/debug only — the drawer does not link out yet. */
  id: string | null;
  /** A short human name for the object, when there is one distinct from the snippet. */
  label: string | null;
  /** The text that actually did the grounding. */
  snippet: string | null;
  /** ISO-ish date string as sent. Formatted for display by {@link formatCitationDate}. */
  date: string | null;
  /** Owner's own words/actions, someone else's, or unstated. */
  voice: EvidenceVoice | null;
}

/**
 * Keys an array of citations might be hung off, most-likely first.
 *
 * `citations` is the one the API actually uses today (inside a wrapper — see
 * {@link CITATION_CONTAINER_KEYS}); the rest are cheap insurance for a shape
 * that is still young.
 */
const CITATION_ARRAY_KEYS = [
  'citations',
  'evidence',
  'evidenceCitations',
  'answerCitations',
  'answerEvidence',
  'sources',
  'groundedIn',
  'lines',
] as const;

/**
 * Keys the retrieved-but-unused array might be hung off.
 *
 * `uncited` is what the API sends (inside the same wrapper as `citations` — see
 * {@link CITATION_CONTAINER_KEYS}); the rest are the same cheap insurance the
 * citation keys carry, for a shape that is still young. Deliberately disjoint
 * from {@link CITATION_ARRAY_KEYS}: an alias appearing in both lists would let
 * one array be read as both groups, and the drawer would show the same records
 * as supporting the answer and as passed over.
 */
const UNCITED_ARRAY_KEYS = ['uncited', 'unused', 'notCited', 'alsoSearched', 'retrieved'] as const;

/**
 * Wrapper objects the array is nested one level inside.
 *
 * Both live shapes land here, and they disagree on the name because they are
 * serialized by different layers:
 *
 *   - `GET /api/questions/catalogue` (Self page, Reflections catalogue) puts it
 *     on the answer as `evidence` — `QuestionCatalogueAnswer.evidence`.
 *   - `GET /api/answers` (Reflections "Your answers") uses the entity's own
 *     column name, `answerEvidence` — `AnswerEntity.toEgressType`.
 *
 * Either way the wrapper is `{ citations, uncited, linesShown, linesOwn, model }`
 * and the two citation arrays are what this module reads out.
 */
const CITATION_CONTAINER_KEYS = [
  'evidence',
  'answerEvidence',
  'provenance',
  'answerProvenance',
  'grounding',
] as const;

const TYPE_KEYS = ['type', 'entityType', 'objectType', 'resourceType', 'kind', 'table'] as const;
const ID_KEYS = ['id', 'entityId', 'objectId', 'sourceId', 'recordId'] as const;
const LABEL_KEYS = ['label', 'title', 'name', 'heading'] as const;
const SNIPPET_KEYS = ['snippet', 'text', 'excerpt', 'quote', 'line', 'content', 'summary'] as const;
const DATE_KEYS = [
  'date',
  'occurredAt',
  'happenedAt',
  'timestamp',
  'startTime',
  'eventTime',
  'at',
  'time',
  'createdAt',
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }

    // A Date survives a non-JSON transport (Apollo cache, a test fixture).
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString();
    }
  }

  return null;
}

/**
 * Voice, in the order the signal is most trustworthy: an explicit `voice`, then
 * an explicit boolean, then the message direction it is derived from on the
 * backend, then a speaker label. Anything unrecognised stays `null` — see
 * {@link EvidenceVoice} for why guessing here is not allowed.
 */
function readVoice(record: Record<string, unknown>): EvidenceVoice | null {
  const voice = record.voice;
  if (voice === 'own' || voice === 'other') {
    return voice;
  }

  for (const key of ['isOwn', 'own', 'isOwnWords', 'byOwner']) {
    const value = record[key];
    if (typeof value === 'boolean') {
      return value ? 'own' : 'other';
    }
  }

  const direction = record.direction;
  if (typeof direction === 'string') {
    const normalized = direction.toLowerCase();
    if (normalized === 'outbound') {
      return 'own';
    }

    if (normalized === 'inbound') {
      return 'other';
    }
  }

  const speaker = readString(record, ['speaker', 'author', 'voiceOf']);
  if (speaker) {
    const normalized = speaker.toLowerCase();
    if (['own', 'owner', 'self', 'you', 'me', 'user'].includes(normalized)) {
      return 'own';
    }

    return 'other';
  }

  return null;
}

/** A bare string in the array is a snippet with nothing else known about it. */
function fromString(value: string, index: number): AnswerCitation | null {
  const snippet = value.trim();

  if (snippet.length === 0) {
    return null;
  }

  return { key: `${index}:text`, type: null, id: null, label: null, snippet, date: null, voice: null };
}

function fromRecord(record: Record<string, unknown>, index: number): AnswerCitation | null {
  const type = readString(record, TYPE_KEYS);
  const id = readString(record, ID_KEYS);
  const label = readString(record, LABEL_KEYS);
  const snippet = readString(record, SNIPPET_KEYS);
  const date = readString(record, DATE_KEYS);

  // Nothing a reader could look at. Dropped rather than rendered as an empty
  // row, which would read as "the evidence is blank" instead of "there is
  // none".
  if (!snippet && !label && !id) {
    return null;
  }

  return {
    key: `${index}:${type ?? 'object'}:${id ?? label ?? snippet ?? ''}`,
    type,
    id,
    // Never repeat the snippet as its own heading.
    label: label && label !== snippet ? label : null,
    snippet,
    date,
    voice: readVoice(record),
  };
}

/**
 * The first array hung off `root`, or off a wrapper one level inside it, under
 * any of `keys`. `null` when there is none — which is the "the API never sent
 * this" state, distinct from an array that arrived empty.
 */
function findArray(root: Record<string, unknown>, keys: readonly string[]): unknown[] | null {
  for (const key of keys) {
    const value = root[key];
    if (Array.isArray(value)) {
      return value;
    }
  }

  for (const key of CITATION_CONTAINER_KEYS) {
    const nested = asRecord(root[key]);
    if (!nested) {
      continue;
    }

    for (const arrayKey of keys) {
      const value = nested[arrayKey];
      if (Array.isArray(value)) {
        return value;
      }
    }
  }

  return null;
}

/** Every renderable citation in `raw`, dropping entries with nothing to show. */
function readCitationArray(raw: unknown[]): AnswerCitation[] {
  return raw.flatMap((entry, index) => {
    if (typeof entry === 'string') {
      const citation = fromString(entry, index);

      return citation ? [citation] : [];
    }

    const asObject = asRecord(entry);
    if (!asObject) {
      return [];
    }

    const citation = fromRecord(asObject, index);

    return citation ? [citation] : [];
  });
}

/**
 * Every database object cited by an answer record, or `[]`.
 *
 * `record` is deliberately `unknown`: callers hand over whatever the API gave
 * them for this answer, without having to know — or keep in sync with — where
 * the citations hang off it.
 */
export function readAnswerCitations(record: unknown): AnswerCitation[] {
  const root = asRecord(record);

  if (!root) {
    return [];
  }

  const raw = findArray(root, CITATION_ARRAY_KEYS);

  return raw ? readCitationArray(raw) : [];
}

/**
 * Every record the model was SHOWN and did not cite, or `null` when this answer
 * does not carry them at all.
 *
 * The `null` is the whole reason this is a separate function from
 * {@link readAnswerCitations} rather than a second call with a different key,
 * and it is not the same as `[]`:
 *
 *   - `null`  — the row was written before unused lines were kept (or by a
 *               build that does not keep them). They are gone. The drawer must
 *               not offer an "also searched" group, because an empty one would
 *               read as "the appliance searched nothing else", which
 *               contradicts the `linesShown` count printed directly above it.
 *   - `[]`    — the model named every line it was shown. There genuinely is
 *               nothing more to see, and saying so is a real answer.
 *
 * Same {@link AnswerCitation} shape as the cited group, deliberately: these
 * render through the same component, and the ONLY thing separating a used
 * record from an unused one is which list it arrived in.
 */
export function readUncitedRecords(record: unknown): AnswerCitation[] | null {
  const root = asRecord(record);

  if (!root) {
    return null;
  }

  const raw = findArray(root, UNCITED_ARRAY_KEYS);

  return raw ? readCitationArray(raw) : null;
}

/** Type names the appliance actually stores, worded for a reader. */
const CITATION_TYPE_LABELS: Record<string, string> = {
  communication: 'Message',
  message: 'Message',
  event: 'Event',
  content: 'Note',
  note: 'Note',
  file: 'File',
  place: 'Place',
  person: 'Person',
  item: 'Thing',
  thing: 'Thing',
  answer: 'Earlier answer',
  entity: 'Graph entity',
  concept: 'Concept',
  organization: 'Organization',
};

/** "Message", "Event"… falling back to a de-snaked version of whatever arrived. */
export function citationTypeLabel(type: string | null): string {
  if (!type) {
    return 'Record';
  }

  const normalized = type.trim().toLowerCase();
  const known = CITATION_TYPE_LABELS[normalized];

  if (known) {
    return known;
  }

  const words = normalized.replace(/[_-]+/g, ' ').trim();

  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A short, local date. Returns the raw string when it does not parse — better
 * to show the reader an odd-looking value the backend really sent than to hide
 * that a date arrived at all.
 */
export function formatCitationDate(date: string | null): string | null {
  if (!date) {
    return null;
  }

  const parsed = new Date(date);

  if (Number.isNaN(parsed.getTime())) {
    return date;
  }

  return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** How the drawer names each voice. `null` gets no claim made about it. */
export const VOICE_LABELS: Record<EvidenceVoice, string> = {
  own: 'Your words',
  other: "Someone else's words",
};

/**
 * The retrieval behind an answer, beside the citations themselves: how much was
 * read, how much of it was the owner's own, and which model did the reading.
 *
 * Read from the same wrapper as the citations (`{ citations, linesShown,
 * linesOwn, model }`), and every field is independently optional — a wrapper
 * written by an older build may carry citations and nothing else.
 */
export interface EvidenceSummary {
  /** Every line put in front of the model, cited or not. */
  linesShown: number | null;
  /** How many of those were the owner's own records rather than other people's. */
  linesOwn: number | null;
  /** The model that wrote the answer. */
  model: string | null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];

  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Whether a retrieval record exists at all for this answer, as opposed to
 * existing and naming nothing.
 *
 * The two are different facts and the drawer says different things about them:
 * a NULL column means no inference ever recorded evidence here (a typed answer,
 * an import, a row from before the column existed), while a wrapper carrying an
 * empty citation list means the model was shown records and named none of them.
 * Collapsing both into "no source records were kept" would have the drawer
 * report nothing was read at the exact moment it also reports how much was —
 * a self-contradiction in the one panel built to stop unbacked claims.
 *
 * The write path cannot produce the second state today (the speaker gate
 * discards an uncited answer rather than storing it), which is precisely why
 * the distinction is made here rather than trusted to stay unreachable.
 */
export function hasEvidenceRecord(record: unknown): boolean {
  const root = asRecord(record);

  if (!root) {
    return false;
  }

  return CITATION_CONTAINER_KEYS.some((key) => asRecord(root[key]) !== null);
}

/** The retrieval summary, or nulls throughout when nothing recorded one. */
export function readEvidenceSummary(record: unknown): EvidenceSummary {
  const empty: EvidenceSummary = { linesShown: null, linesOwn: null, model: null };
  const root = asRecord(record);

  if (!root) {
    return empty;
  }

  for (const key of CITATION_CONTAINER_KEYS) {
    const wrapper = asRecord(root[key]);

    if (wrapper) {
      return {
        linesShown: readNumber(wrapper, 'linesShown'),
        linesOwn: readNumber(wrapper, 'linesOwn'),
        model: readString(wrapper, ['model']),
      };
    }
  }

  return empty;
}

/**
 * The sentence that has to be right for the panel to be honest, given how many
 * records were CITED and how many were merely SEARCHED.
 *
 * ═══ WHAT THIS REPLACED, AND WHY ═══
 *
 * The old copy printed one fact — "20 records were put in front of the model, 14
 * of them your own" — directly above a list of two, and never said what the two
 * were. The owner read it exactly as written: eighteen records withheld. Nothing
 * on screen contradicted that, because "put in front of the model" is a
 * statement about RETRIEVAL and the list underneath is a statement about
 * CITATION, and only one of them was labelled.
 *
 * So the count that leads is now the one the list is: how many records SUPPORT
 * the answer. The retrieval total follows as a second clause, subordinate,
 * clearly a wider set — and the records inside it are shown too, in their own
 * group, so the number is never the only evidence that they exist.
 *
 * Returns a single string rather than fragments because the two clauses have to
 * be read together; splitting them across elements is how the original lost the
 * relationship between them.
 */
export function evidenceScopeSentence(
  citedCount: number,
  summary: Pick<EvidenceSummary, 'linesShown' | 'linesOwn'>,
): string {
  const supported =
    citedCount === 0
      ? 'No record was named as supporting this answer.'
      : citedCount === 1
        ? '1 record supports this answer.'
        : `${citedCount} records support this answer.`;

  const { linesShown, linesOwn } = summary;

  // Only a WIDER set is worth a second clause. When retrieval returned exactly
  // what was cited there is no gap to explain, and "2 records support this
  // answer. 2 were searched." invites the reader to look for a distinction that
  // is not there.
  if (typeof linesShown !== 'number' || linesShown <= citedCount) {
    return supported;
  }

  const own =
    typeof linesOwn === 'number' ? `, ${linesOwn === linesShown ? 'all' : linesOwn} of them your own` : '';

  return `${supported} ${linesShown} were searched${own}.`;
}

/**
 * How many searched records are not accounted for by either list on screen.
 *
 * Non-zero in exactly two situations, and the drawer has to admit both rather
 * than let the reader do arithmetic that comes out wrong:
 *
 *   1. The write path capped one of the arrays (24 uncited, 8 cited).
 *   2. The row was written before the uncited lines were kept at all, in which
 *      case this is every line the model did not cite.
 *
 * `0` whenever the numbers do reconcile, and whenever `linesShown` was never
 * recorded — there is no shortfall to claim without a total to measure against.
 */
export function unaccountedEvidenceCount(
  citedCount: number,
  uncitedCount: number,
  summary: Pick<EvidenceSummary, 'linesShown'>,
): number {
  if (typeof summary.linesShown !== 'number') {
    return 0;
  }

  return Math.max(0, summary.linesShown - citedCount - uncitedCount);
}
