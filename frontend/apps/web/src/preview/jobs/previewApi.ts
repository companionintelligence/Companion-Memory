/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE JOBS API, WITHOUT A DATABASE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A Vite middleware that answers every request the Jobs page makes, out of the
 * fixture corpus next door. The page runs unmodified: real hooks, real polling,
 * real debounce, real snapshot cache, real auth context — only the appliance is
 * absent.
 *
 * ── Why the seam is HTTP and not the hooks ─────────────────────────────────
 *
 * The harness this replaces (a scratch file, never committed — see the commit
 * that added the `jobs-preview` entry to `.claude/launch.json`) aliased the
 * page's hooks to captured payloads. That renders the page, but it also
 * replaces the code most worth previewing: `useJobsList` builds the query
 * string, debounces the search, and reads back a snapshot cache, and a stubbed
 * hook proves none of it. Answering over HTTP leaves every one of those in the
 * path, and makes the filters actually filter.
 *
 * ── Why the filtering is duplicated here ───────────────────────────────────
 *
 * `state`, `queue`, `category`, `type` and `search` are applied in SQL by
 * `JobQueryService`, and the whole design of the page assumes it: the table
 * pages over `pgboss.job`, which holds tens of thousands of rows during an
 * import. A preview that returned the same 50 rows whatever the filters said
 * would show a page that cannot be wrong. So the semantics are reimplemented
 * here against the fixture rows — including the two that are easy to get wrong
 * and were: `stateCounts` ignores the state filter (so the tabs say what
 * PICKING each one would yield, rather than collapsing to the one already
 * picked), and `dead-letter` is a QUEUE selector, not a state.
 *
 * If those semantics change server-side, this file is wrong and the preview
 * lies. It is a dev harness, not a test — `JobQueryService`'s own specs are
 * what guard the real contract.
 *
 * The taxonomy is NOT duplicated: `describeJob` is imported from the backend
 * (it is a dependency-free data module), so labels and categories in the
 * preview are the ones the appliance would actually serve.
 */

import type { Connect, Plugin } from 'vite';

// The backend's taxonomy, imported rather than copied. It has no imports of its
// own — see the head of that file — so this crosses the workspace boundary
// without dragging Nest in. This is dev-server code; nothing here is bundled
// into the browser.
import {
  categoryOfEvent,
  describeJob,
  jobCategorySelector,
  JOB_CATEGORIES,
  JOB_TYPES,
  UNCLASSIFIED_CATEGORY,
} from '../../../../../../backend/apps/api/src/domains/events/taxonomy';

import {
  buildActiveImport,
  buildArchive,
  buildCrons,
  buildDeadLetters,
  buildJobRows,
  buildQueueRegistry,
  distributionKey,
  metricQueues,
  metricsForBucket,
  PREVIEW_USER_ID,
  type PreviewArchive,
  type PreviewArchiveRow,
  type PreviewDeadLetter,
  type PreviewJobRow,
} from './fixtures';

const DEAD_LETTER_QUEUE = 'dead-letter';

/** `JobQueryService`'s own bounds. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** What the dashboard renders: 25 recent rows, top-15 / top-10 distributions. */
const RECENT_LIMIT = 25;

interface Corpus {
  /** Epoch millis the rows are anchored to — fixed at first request. */
  readonly anchor: number;
  readonly jobs: readonly PreviewJobRow[];
  readonly archive: PreviewArchive;
  /** Mutable: the replay endpoint stamps `replayedAt` on these. */
  readonly deadLetters: PreviewDeadLetter[];
}

let corpus: Corpus | null = null;

/**
 * Build the heavy rows once and keep them.
 *
 * Anchored at first request rather than at module load so the page's
 * "2 minutes ago" is honest whenever the preview is opened, and stable
 * afterwards — a corpus regenerated per poll would make every row jump.
 */
function getCorpus(): Corpus {
  if (!corpus) {
    const anchor = Date.now();

    corpus = {
      anchor,
      jobs: buildJobRows({ now: anchor }),
      archive: buildArchive({ now: anchor }),
      deadLetters: buildDeadLetters({ now: anchor }),
    };
  }

  return corpus;
}

// ── The list ───────────────────────────────────────────────────────────────

interface Filters {
  readonly state: string;
  readonly queue: string;
  readonly category: string;
  readonly type: string;
  readonly search: string;
}

function eventOf(row: PreviewJobRow): string | null {
  const name = row.data['name'];

  return typeof name === 'string' ? name : null;
}

function workTypeOf(row: PreviewJobRow): string | null {
  const workType = row.data['workType'];

  return typeof workType === 'string' ? workType : null;
}

interface CategorySets {
  readonly events: ReadonlySet<string>;
  readonly include: ReadonlySet<string>;
  readonly exclude: ReadonlySet<string>;
}

/**
 * A category's membership test, as sets.
 *
 * Memoized because `matches` runs per row and the corpus is ~17k rows a
 * request. The selector itself comes from the backend taxonomy, so the preview
 * files a queue-scoped event under the same category the appliance would —
 * `content.created` on `pipeline-index` is `pipeline`, not `search`.
 */
const categorySets = new Map<string, CategorySets>();

function categorySetsFor(category: string): CategorySets {
  const cached = categorySets.get(category);

  if (cached) {
    return cached;
  }

  const selector = jobCategorySelector(category);
  const sets: CategorySets = {
    events: new Set(selector.events),
    include: new Set(selector.includeQueueKeys),
    exclude: new Set(selector.excludeQueueKeys),
  };

  categorySets.set(category, sets);

  return sets;
}

/**
 * `applyFilters`, minus SQL.
 *
 * `skipState` is what the state tabs are counted with — see the docblock at the
 * head of this file.
 */
function matches(
  row: PreviewJobRow,
  filters: Filters,
  options: { skipState?: boolean; skipCategory?: boolean; skipType?: boolean } = {},
): boolean {
  if (filters.state && !options.skipState) {
    if (filters.state === 'dead-letter') {
      if (row.name !== DEAD_LETTER_QUEUE) {
        return false;
      }
    } else if (row.state !== filters.state || row.name === DEAD_LETTER_QUEUE) {
      return false;
    }
  }

  if (filters.queue && row.name !== filters.queue) {
    return false;
  }

  const event = eventOf(row);

  if (filters.type && !options.skipType && event !== filters.type) {
    return false;
  }

  if (filters.category && !options.skipCategory) {
    // An unknown category matches nothing rather than everything: a typo in a
    // query string should empty the table, not un-filter it.
    const sets = categorySetsFor(filters.category);
    const pair = `${event}::${row.name}`;
    // The base entry, unless this queue moves it out — plus anything a queue
    // moves in. Same three-way test the SQL does.
    const inCategory =
      sets.include.has(pair) || (event != null && sets.events.has(event) && !sets.exclude.has(pair));

    if (!inCategory) {
      return false;
    }
  }

  if (filters.search) {
    const term = filters.search.trim().toLowerCase();
    const failure = row.output?.['message'];
    // The failure message is another user's job output, so the server only
    // matches it on rows the caller owns. Mirrored here so a search that hits
    // nothing in the preview would also hit nothing on the appliance.
    const ownsRow = row.data['userId'] === PREVIEW_USER_ID;

    const hit =
      (event ?? '').toLowerCase().includes(term) ||
      row.name.toLowerCase().includes(term) ||
      (ownsRow && typeof failure === 'string' && failure.toLowerCase().includes(term));

    if (!hit) {
      return false;
    }
  }

  return true;
}

function toFailure(
  output: Record<string, unknown> | null,
): { message: string; stack?: string; failedAt?: string } | null {
  if (!output) {
    return null;
  }

  const message = typeof output['message'] === 'string' ? output['message'].trim() : '';

  if (!message) {
    return null;
  }

  return {
    message,
    stack: typeof output['stack'] === 'string' ? output['stack'] : undefined,
    failedAt: typeof output['failedAt'] === 'string' ? output['failedAt'] : undefined,
  };
}

function payloadBytes(data: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(data) ?? '', 'utf8');
}

function toListItem(row: PreviewJobRow): Record<string, unknown> {
  const event = eventOf(row);
  const workType = workTypeOf(row);
  // `row.name` is the QUEUE — it is what disambiguates an event two unrelated
  // listeners share, which is why describeJob takes it.
  const descriptor = describeJob(event, workType, row.name);

  return {
    id: row.id,
    queue: row.name,
    state: row.state,
    event,
    workType,
    label: descriptor.label,
    category: descriptor.category,
    description: descriptor.description,
    interactive: Boolean(descriptor.interactive),
    createdOn: row.createdOn.toISOString(),
    startedOn: row.startedOn ? row.startedOn.toISOString() : null,
    completedOn: row.completedOn ? row.completedOn.toISOString() : null,
    durationMs:
      row.startedOn && row.completedOn
        ? Math.max(row.completedOn.getTime() - row.startedOn.getTime(), 0)
        : null,
    retryCount: row.retryCount,
    retryLimit: row.retryLimit,
    payloadBytes: payloadBytes(row.data),
    failure: toFailure(row.output),
    deadLettered: row.name === DEAD_LETTER_QUEUE,
  };
}

/** `created_on DESC, id DESC` — the tie-break is what keeps paging stable. */
function byNewest(a: PreviewJobRow, b: PreviewJobRow): number {
  const byTime = b.createdOn.getTime() - a.createdOn.getTime();

  return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
}

/**
 * Arrivals per category over time, for the "Job types over time" chart.
 *
 * Bucketed off the corpus's own `createdOn`, so the chart lines up with the
 * table beside it rather than being a second, unrelated invention. `source` is
 * reported as `live` because that is what this is — the preview has no sampled
 * `ci.job_category_metrics` to fall back to, and claiming `mixed` would be
 * showing an operator a seam that does not exist here.
 */
function categoryHistory(now: number, params: URLSearchParams): Record<string, unknown> {
  const { jobs } = getCorpus();
  const windowHours = Math.min(Math.max(Number(params.get('hours')) || 24, 1), 24 * 30);
  const bucketMinutes = windowHours <= 24 ? 30 : windowHours <= 24 * 7 ? 180 : 720;
  const bucketMs = bucketMinutes * 60_000;
  const from = now - windowHours * 3_600_000;

  const buckets = new Map<number, Record<string, number>>();
  const seen = new Set<string>();

  for (const row of jobs) {
    // A dead-letter copy carries a FRESH created_on, so counting it would draw
    // a burst of new work at the exact moment work started failing. The failed
    // original supplies the real arrival.
    if (row.name === DEAD_LETTER_QUEUE) {
      continue;
    }

    const at = row.createdOn.getTime();

    if (!Number.isFinite(at) || at < from) {
      continue;
    }

    const key = Math.floor(at / bucketMs) * bucketMs;
    const bucket = buckets.get(key) ?? {};
    const category = categoryOfEvent(eventOf(row));

    bucket[category] = (bucket[category] ?? 0) + 1;
    seen.add(category);
    buckets.set(key, bucket);
  }

  const categories = [...seen].sort();
  const points = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([at, counts]) => ({
      at: new Date(at).toISOString(),
      // Zero-filled across every series, or the chart draws gaps where a
      // category simply had nothing that half-hour.
      counts: Object.fromEntries(categories.map((category) => [category, counts[category] ?? 0])),
    }));

  return { points, categories, bucketMinutes, windowHours, source: 'live' };
}

/**
 * The operator controls, derived from the corpus rather than invented.
 *
 * Modes are held in a module-level map so a toggle in the preview STICKS for the
 * life of the dev server — a switch that snaps back on the next poll teaches the
 * wrong thing about a control whose whole point is that it persists. It is
 * deliberately not written to disk: the preview corpus is regenerated from a
 * seed on every boot, and a control surviving into a different corpus would
 * point at queues that no longer exist.
 */
const previewModes = new Map<string, string>();

function controls(now: number): Record<string, unknown> {
  const { jobs } = getCorpus();
  const crons = buildCrons({ now });
  const queueNames = [...new Set(jobs.map((row) => row.name))].filter((n) => n !== DEAD_LETTER_QUEUE).sort();

  const num = (value: number | null, def: number, max: number) => ({
    value,
    default: def,
    max,
    effective: value ?? def,
  });

  return {
    global: {
      // `max` mirrors `default`: the two global numbers only go down, so the
      // shipped figure is also the ceiling the API will honour.
      concurrency: num(null, 10, 10),
      perQueueConcurrency: num(null, 6, 6),
      nonInteractive: previewModes.get('__global__') ?? 'enabled',
    },
    topology: { role: 'all', queueWorkerProcesses: 1, perProcessConcurrency: 10 },
    queues: queueNames.map((name) => {
      // Which categories ride this queue, read off the jobs actually on it —
      // so the grouping in the card matches the table on the same page.
      const categories = [
        ...new Set(jobs.filter((row) => row.name === name).map((row) => categoryOfEvent(eventOf(row)))),
      ].sort();

      return {
        name,
        mode: previewModes.get(`queue:${name}`) ?? 'enabled',
        pausedByGlobal: (previewModes.get('__global__') ?? 'enabled') === 'paused',
        concurrency: num(null, 6, 64),
        declaredConcurrency: null,
        role: name.startsWith('import-') || name === 'derivation-run' ? 'worker' : 'web',
        interactive: name === 'llm',
        categories,
        jobTypes: [],
        // A queue carrying work a person is waiting on refuses to be switched
        // off, and says why rather than rendering a dead switch.
        locked: name === 'llm',
        lockedReason: name === 'llm' ? 'Chat runs on this queue — turning it off would break replies.' : null,
        skippedCount: 0,
        lastSkippedAt: null,
      };
    }),
    crons: crons.map((cron: { name: string; cron: string }) => ({
      name: cron.name,
      cron: cron.cron ?? '',
      mode: previewModes.get(`cron:${cron.name}`) ?? 'enabled',
      role: 'web' as const,
      // The preview is a single-process appliance, so nothing runs elsewhere and
      // the card's "N run in the worker process" note stays silent.
      servedHere: true,
      locked: false,
      lockedReason: null,
      skippedCount: 0,
      lastSkippedAt: null,
    })),
    maxConcurrency: 64,
  };
}

/** Apply a patch the way the real endpoint does: merge, never replace. */
function updateControls(body: Record<string, unknown>, now: number): Record<string, unknown> {
  const global = body['global'] as { nonInteractive?: string } | undefined;

  if (global?.nonInteractive) {
    previewModes.set('__global__', global.nonInteractive);
  }

  for (const queue of (body['queues'] as Array<{ name: string; mode?: string }>) ?? []) {
    if (queue.mode) {
      previewModes.set(`queue:${queue.name}`, queue.mode);
    }
  }

  for (const cron of (body['crons'] as Array<{ name: string; mode?: string }>) ?? []) {
    if (cron.mode) {
      previewModes.set(`cron:${cron.name}`, cron.mode);
    }
  }

  return controls(now);
}

function listJobs(params: URLSearchParams): Record<string, unknown> {
  const { jobs } = getCorpus();

  const filters: Filters = {
    state: params.get('state') ?? '',
    queue: params.get('queue') ?? '',
    category: params.get('category') ?? '',
    type: params.get('type') ?? '',
    search: params.get('search') ?? '',
  };

  const limit = Math.min(Math.max(Number(params.get('limit')) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(Number(params.get('offset')) || 0, 0);

  const matched = jobs.filter((row) => matches(row, filters));
  const page = [...matched].sort(byNewest).slice(offset, offset + limit);

  // Counts under every filter EXCEPT state, so each tab says what picking it
  // would yield. `dead-letter` buckets by queue, because it is one.
  const stateCounts: Record<string, number> = {};

  for (const row of jobs) {
    if (!matches(row, filters, { skipState: true })) {
      continue;
    }

    const bucket = row.name === DEAD_LETTER_QUEUE ? 'dead-letter' : row.state;

    stateCounts[bucket] = (stateCounts[bucket] ?? 0) + 1;
  }

  // Counts under every filter EXCEPT category and type, so each chip says what
  // picking IT would yield — the same contract stateCounts gives the tabs.
  //
  // Folded from the EVENT NAME alone, never the queue: pg-boss rewrites the
  // queue column on a dead-letter copy, so a queue-keyed fold would lose every
  // dead-lettered row into one bucket. Same reason the real endpoint does it
  // this way, and the reason the preview corpus is worth having a dead-letter
  // pile in at all.
  const categoryCounts: Record<string, number> = {};

  for (const category of Object.values(JOB_CATEGORIES)) {
    categoryCounts[category] = 0;
  }

  categoryCounts[UNCLASSIFIED_CATEGORY] = 0;

  for (const row of jobs) {
    if (!matches(row, filters, { skipCategory: true, skipType: true })) {
      continue;
    }

    const bucket = categoryOfEvent(eventOf(row));

    categoryCounts[bucket] = (categoryCounts[bucket] ?? 0) + 1;
  }

  return {
    items: page.map(toListItem),
    total: matched.length,
    limit,
    offset,
    categoryCounts,
    // Distinct queues across the WHOLE table, not the filtered set — otherwise
    // picking a queue would empty the queue filter of every other option.
    queues: [...new Set(jobs.map((row) => row.name))].sort(),
    stateCounts,
  };
}

// ── The dashboard ──────────────────────────────────────────────────────────

function toJobRecord(row: PreviewJobRow): Record<string, unknown> {
  return {
    id: row.id,
    queue: row.name,
    state: row.state,
    priority: row.priority,
    retryLimit: row.retryLimit,
    retryCount: row.retryCount,
    retryDelay: 30,
    retryBackoff: true,
    createdOn: row.createdOn.toISOString(),
    startAfter: row.startAfter.toISOString(),
    startedOn: row.startedOn?.toISOString(),
    completedOn: row.completedOn?.toISOString(),
    deadLetter: row.deadLetter,
    policy: row.policy,
    event: eventOf(row),
    workType: workTypeOf(row),
    payloadBytes: payloadBytes(row.data),
    failure: toFailure(row.output),
  };
}

function toArchivedRecord(row: PreviewArchiveRow): Record<string, unknown> {
  return { ...toJobRecord(row), archivedOn: row.archivedOn.toISOString() };
}

function countBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, number> {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const bucket = key(row);

    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  return counts;
}

function topCounts(counts: Map<string, number>, limit: number, label: string): Record<string, unknown>[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ [label]: name, count }));
}

/**
 * Health-card Clear — drop terminal rows from the live corpus so the next
 * dashboard poll matches what the appliance would show after `POST /jobs/clear`.
 */
function clearTerminalJobs(body: unknown): Record<string, unknown> {
  const scope =
    body && typeof body === 'object' && 'scope' in body && typeof (body as { scope: unknown }).scope === 'string'
      ? (body as { scope: string }).scope
      : null;

  if (scope !== 'dead-letter' && scope !== 'failed') {
    throw new Error(`clearTerminalJobs: scope must be dead-letter or failed (got ${String(scope)})`);
  }

  const current = getCorpus();
  const before = current.jobs.length;
  const nextJobs =
    scope === 'dead-letter'
      ? current.jobs.filter((row) => row.name !== DEAD_LETTER_QUEUE)
      : current.jobs.filter((row) => !(row.state === 'failed' && row.name !== DEAD_LETTER_QUEUE));

  corpus = { ...current, jobs: nextJobs };

  return { scope, deleted: before - nextJobs.length };
}

function dashboard(now: number): Record<string, unknown> {
  const { jobs, archive } = getCorpus();

  const live = countBy(jobs, (row) => row.state);
  const deadLettered = jobs.filter((row) => row.name === DEAD_LETTER_QUEUE).length;

  return {
    summary: {
      // Dead letters are stored as `created` on their own queue. Counting them
      // as pending reported 1,191 dead jobs as a live backlog on a real
      // appliance, while the same jobs were also counted under `failed`.
      pending: Math.max((live.get('created') ?? 0) - deadLettered, 0),
      active: live.get('active') ?? 0,
      retry: live.get('retry') ?? 0,
      completed: (live.get('completed') ?? 0) + archive.counts.completed,
      failed: (live.get('failed') ?? 0) + archive.counts.failed,
      cancelled: (live.get('cancelled') ?? 0) + archive.counts.cancelled,
      deadLettered,
      // pg-boss's own scheduler is off in this repo (`schedule: false`), so its
      // schedule table is empty on a real appliance too.
      scheduled: 0,
    },
    archiveDistribution: archive.distribution,
    activeDistribution: topCounts(
      countBy(jobs, (row) => distributionKey(eventOf(row), workTypeOf(row), row.name)),
      15,
      'jobName',
    ),
    queueDistribution: topCounts(
      countBy(jobs, (row) => row.name),
      10,
      'queue',
    ),
    smartRotationDistribution: topCounts(
      countBy(
        jobs.filter((row) => eventOf(row) === 'smart.rotation.work'),
        (row) => workTypeOf(row) ?? 'unknown',
      ),
      15,
      'workType',
    ),
    jobs: [...jobs].sort(byNewest).slice(0, RECENT_LIMIT).map(toJobRecord),
    archive: archive.recent.map(toArchivedRecord),
    // pg-boss's own `schedule` table. Nothing in this repo writes it.
    schedules: [],
    crons: buildCrons({ now }),
    queues: buildQueueRegistry({ now }),
  };
}

// ── History ────────────────────────────────────────────────────────────────

function history(now: number, params: URLSearchParams): Record<string, unknown> {
  const requested = Number(params.get('hours'));
  const windowHours = Math.min(
    Math.max(Number.isFinite(requested) && requested ? requested : 24, 1),
    24 * 30,
  );
  const queue = params.get('queue') || undefined;

  // Bucket width scales with the window, and the collector's 5-minute sample is
  // the floor. Same ladder as JobQueryService.
  const bucketMinutes = windowHours <= 6 ? 5 : windowHours <= 48 ? 30 : 180;
  const bucketMs = bucketMinutes * 60_000;

  const since = now - windowHours * 3_600_000;
  const first = Math.floor(since / bucketMs) * bucketMs;

  const points: Record<string, unknown>[] = [];

  for (let at = first; at <= now; at += bucketMs) {
    points.push({
      at: new Date(at).toISOString(),
      ...metricsForBucket({ now, bucketStartMs: at, bucketMinutes, queue }),
    });
  }

  return { points, queues: metricQueues(), bucketMinutes, windowHours };
}

// ── Dead letters ───────────────────────────────────────────────────────────

function deadLetters(params: URLSearchParams): Record<string, unknown> {
  const { deadLetters: letters } = getCorpus();
  const limit = Math.min(Math.max(Number(params.get('limit')) || 200, 1), 200);
  const unreplayedOnly = params.get('replayed') === 'false';

  return {
    deadLetters: letters
      .filter((letter) => !unreplayedOnly || letter.replayedAt == null)
      .sort((a, b) => Date.parse(b.failedAt) - Date.parse(a.failedAt))
      .slice(0, limit),
  };
}

/**
 * Replay, which actually replays.
 *
 * Stamps `replayedAt` on the claimed letters, so the card's button does what it
 * says: the group disappears from the list on the reload that follows. The
 * endpoint claims only un-replayed rows (`replayed_at IS NULL`), which is what
 * makes a double-click harmless — mirrored here.
 */
function replayDeadLetters(body: unknown): Record<string, unknown> {
  const { deadLetters: letters } = getCorpus();
  const ids = Array.isArray((body as { ids?: unknown })?.ids)
    ? ((body as { ids: unknown[] }).ids.filter((id) => typeof id === 'string') as string[])
    : [];

  const replayed: Array<{ id: string; jobIds: string[] }> = [];
  const skipped: string[] = [];
  const stamp = new Date().toISOString();

  for (const id of ids) {
    const letter = letters.find((candidate) => candidate.id === id);

    if (!letter) {
      skipped.push(id);
      continue;
    }

    if (letter.replayedAt != null) {
      // Already claimed by an earlier submit — not a failure, just nothing to do.
      skipped.push(id);
      continue;
    }

    letter.replayedAt = stamp;
    replayed.push({ id, jobIds: [`${id}-replay`] });
  }

  return {
    requested: ids.length,
    claimed: replayed.length,
    limit: 200,
    replayed,
    failed: [],
    skipped,
  };
}

// ── Auth ───────────────────────────────────────────────────────────────────

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * A JWT the client can decode but nothing can verify.
 *
 * `useAuth` runs unmodified in the preview, and it `jwtDecode`s this to read
 * `exp` and `sub` — so it has to be a real three-segment token, not a
 * placeholder string. Nothing checks the signature because nothing here is a
 * server: the preview has no session, no user, and no data that is anyone's.
 */
function previewJwt(now: number): string {
  const issued = Math.floor(now / 1000);

  return [
    base64url({ alg: 'HS256', typ: 'JWT' }),
    base64url({ sub: PREVIEW_USER_ID, iat: issued, exp: issued + 24 * 60 * 60 }),
    'preview-not-a-signature',
  ].join('.');
}

// ── Wiring ─────────────────────────────────────────────────────────────────

function send(res: Parameters<Connect.NextHandleFunction>[1], status: number, body: unknown): void {
  const payload = JSON.stringify(body);

  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
}

async function readBody(req: Parameters<Connect.NextHandleFunction>[0]): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * Every route the Jobs page touches. Anything else under `/api` is answered
 * 501, loudly and by name: a preview that silently 404s a new endpoint looks
 * like a broken page, and a preview that fell through to a real appliance would
 * be worse than either.
 */
export function jobsPreviewApi(): Plugin {
  return {
    name: 'ci:jobs-preview-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';

        if (!url.startsWith('/api/')) {
          next();

          return;
        }

        const { pathname, searchParams } = new URL(url, 'http://preview.local');
        const now = Date.now();

        try {
          switch (`${req.method ?? 'GET'} ${pathname}`) {
            case 'GET /api/jobs':
              send(res, 200, listJobs(searchParams));

              return;

            case 'GET /api/jobs/dashboard':
              send(res, 200, dashboard(now));

              return;

            case 'GET /api/jobs/history':
              send(res, 200, history(now, searchParams));

              return;

            case 'GET /api/jobs/controls':
              send(res, 200, controls(now));

              return;

            case 'PUT /api/jobs/controls':
              send(res, 200, updateControls((await readBody(req)) as Record<string, unknown>, now));

              return;

            case 'GET /api/jobs/history/categories':
              send(res, 200, categoryHistory(now, searchParams));

              return;

            case 'GET /api/jobs/types':
              // Served straight off the backend taxonomy, exactly as
              // JobsController serves it.
              send(res, 200, {
                categories: Object.values(JOB_CATEGORIES),
                types: Object.fromEntries(
                  Object.entries(JOB_TYPES).map(([event, descriptor]) => [
                    event,
                    {
                      label: descriptor.label,
                      category: descriptor.category,
                      description: descriptor.description,
                      interactive: Boolean(descriptor.interactive),
                    },
                  ]),
                ),
              });

              return;

            case 'GET /api/pipeline/dead-letters':
              send(res, 200, deadLetters(searchParams));

              return;

            case 'POST /api/pipeline/dead-letters/replay':
              send(res, 200, replayDeadLetters(await readBody(req)));

              return;

            case 'POST /api/jobs/clear':
              send(res, 200, clearTerminalJobs(await readBody(req)));

              return;

            case 'GET /api/import/runs/active':
              send(res, 200, buildActiveImport({ now }));

              return;

            case 'GET /api/authenticate/csrf':
              send(res, 200, { csrfToken: 'preview-csrf-token' });

              return;

            case 'POST /api/authenticate/refresh':
              send(res, 200, { accessToken: previewJwt(now) });

              return;

            default:
              send(res, 501, {
                message: `The Jobs fixture preview does not serve ${req.method} ${pathname}. Add it to previewApi.ts, or run the real API.`,
              });
          }
        } catch (error: unknown) {
          // A throw in here would otherwise surface in the browser as a hung
          // request, which reads like a page bug rather than a harness bug.
          server.config.logger.error(`[jobs-preview] ${pathname} failed: ${String(error)}`);
          send(res, 500, { message: String(error) });
        }
      });
    },
  };
}
