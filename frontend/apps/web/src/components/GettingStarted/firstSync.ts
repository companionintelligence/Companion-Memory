/**
 * What the getting-started banner says, derived from what the appliance knows.
 *
 * Pure on purpose: every line the banner shows is a function of a handful of
 * numbers, and the interesting cases — "parsed but never saved", "still
 * indexing", "connected but nothing has arrived yet" — are exactly the ones a
 * component test makes awkward to reach. `null` means "not answered yet" and is
 * never treated as zero: an unanswered count must not read as "you have no
 * data", and it must not read as "you are done" either.
 */

/** Row counts of the user's memory, as `GET /v1/ingest/status` reports them. */
export interface MemoryTotals {
  readonly communications: number;
  readonly events: number;
  readonly content: number;
  readonly objects: number;
  readonly browser_activity: number;
  readonly position: number;
}

export interface FirstSyncInputs {
  readonly hasModel: boolean;
  readonly modelsLoading: boolean;
  /** Connected accounts. `null` until the query has answered. */
  readonly connectionCount: number | null;
  /** Imports that finished parsing but were never saved into memory. `null` = unknown. */
  readonly unpushedRuns: number | null;
  /** Imports in flight right now. `null` = unknown. */
  readonly runningImports: number | null;
  /** Records the in-flight imports have read so far. */
  readonly runningRecords: number;
  readonly totals: MemoryTotals | null;
  /** Items still queued for the search index. `null` = unknown. */
  readonly indexingItems: number | null;
}

export type StepStatus = 'done' | 'todo' | 'working' | 'attention' | 'unknown';

export type StepId = 'model' | 'data' | 'memory';

export interface ChecklistStep {
  readonly id: StepId;
  readonly status: StepStatus;
  readonly title: string;
  readonly detail: string;
}

export interface Checklist {
  readonly steps: readonly ChecklistStep[];
  readonly doneCount: number;
  readonly allDone: boolean;
  /** "12,400 messages · 3,102 events" — what is in memory now; null while empty or unknown. */
  readonly countsLine: string | null;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

export function totalRecords(totals: MemoryTotals | null): number {
  if (!totals) {
    return 0;
  }

  return (
    totals.communications +
    totals.events +
    totals.content +
    totals.objects +
    totals.browser_activity +
    totals.position
  );
}

/** The three or four biggest kinds of thing in memory, in words a person would use. */
export function countsLine(totals: MemoryTotals | null): string | null {
  if (!totals) {
    return null;
  }

  const parts: Array<[number, string]> = [
    [totals.communications, plural(totals.communications, 'message', 'messages')],
    [totals.events, plural(totals.events, 'event', 'events')],
    [totals.content, plural(totals.content, 'piece of content', 'pieces of content')],
    [totals.browser_activity, plural(totals.browser_activity, 'page visit', 'page visits')],
    [totals.position, plural(totals.position, 'location', 'locations')],
    [totals.objects, plural(totals.objects, 'thing', 'things')],
  ];

  const shown = parts
    .filter(([n]) => n > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 3)
    .map(([, text]) => text);

  return shown.length > 0 ? shown.join(' · ') : null;
}

export function deriveChecklist(input: FirstSyncInputs): Checklist {
  const records = totalRecords(input.totals);
  const connections = input.connectionCount ?? 0;
  const unpushed = input.unpushedRuns ?? 0;
  const running = input.runningImports ?? 0;
  const indexing = input.indexingItems ?? 0;

  // ── 1. A model to answer with ────────────────────────────────────────────
  const model: ChecklistStep = input.hasModel
    ? { id: 'model', status: 'done', title: 'Chat model ready', detail: 'Chat and summaries can answer.' }
    : input.modelsLoading
      ? { id: 'model', status: 'unknown', title: 'Checking for a chat model…', detail: '' }
      : {
          id: 'model',
          status: 'todo',
          title: 'Choose a chat model',
          detail: 'Chat needs a model running on your own hardware before it can answer.',
        };

  // ── 2. Something to remember ─────────────────────────────────────────────
  const hasData = connections > 0 || records > 0 || unpushed > 0 || running > 0;
  const dataAnswered = input.connectionCount !== null || input.totals !== null;
  const data: ChecklistStep = hasData
    ? {
        id: 'data',
        status: 'done',
        title: 'Data source added',
        detail:
          connections > 0
            ? `${plural(connections, 'account', 'accounts')} connected.`
            : 'An import is on its way in.',
      }
    : !dataAnswered
      ? { id: 'data', status: 'unknown', title: 'Checking your sources…', detail: '' }
      : {
          id: 'data',
          status: 'todo',
          title: 'Connect a source or import an archive',
          detail: 'Nothing is in your memory yet.',
        };

  // ── 3. Getting it into memory ────────────────────────────────────────────
  let memory: ChecklistStep;

  if (!hasData) {
    memory = {
      id: 'memory',
      status: dataAnswered ? 'todo' : 'unknown',
      title: 'Save it to your memory',
      detail: 'Follows once a source is added.',
    };
  } else if (unpushed > 0) {
    // The gap the wizard leaves: an import finishes parsing after the user has
    // moved on, and nothing enters memory until it is saved.
    memory = {
      id: 'memory',
      status: 'attention',
      title: `${plural(unpushed, 'import is', 'imports are')} read but not saved yet`,
      detail: 'Nothing from it is searchable until you save it to your memory.',
    };
  } else if (running > 0) {
    memory = {
      id: 'memory',
      status: 'working',
      title: `${plural(running, 'import', 'imports')} running`,
      detail:
        input.runningRecords > 0
          ? `${plural(input.runningRecords, 'record', 'records')} read so far — big archives take a while.`
          : 'Unpacking and reading — big archives take a while.',
    };
  } else if (records === 0) {
    memory = {
      id: 'memory',
      status: 'working',
      title: 'Waiting for the first sync',
      detail: 'Connected accounts sync in the background; the first records can take a few minutes.',
    };
  } else if (indexing > 0) {
    memory = {
      id: 'memory',
      status: 'working',
      title: `Still indexing ${plural(indexing, 'item', 'items')}`,
      detail: 'Everything is saved. Search by meaning fills in as indexing catches up.',
    };
  } else {
    memory = {
      id: 'memory',
      status: 'done',
      title: 'In your memory',
      detail: 'Saved and indexed.',
    };
  }

  const steps = [model, data, memory] as const;
  const doneCount = steps.filter((step) => step.status === 'done').length;

  return {
    steps,
    doneCount,
    allDone: doneCount === steps.length,
    countsLine: countsLine(input.totals),
  };
}
