import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { JobsPage } from './JobsPage';
import type { DeadLetterGroup } from './useDeadLetters';
import type { JobCategoryHistoryResponse } from './useJobCategoryHistory';
import type { JobControlsResponse } from './useJobControls';
import type { JobHistoryResponse } from './useJobHistory';
import type { JobsDashboardResponse } from './useJobsDashboard';
import type { JobListItem, JobListResponse } from './useJobsList';

/**
 * The Jobs dashboard, rebuilt around one filterable table.
 *
 * These drive the page through its three hooks rather than the network, because
 * what is under test is what the page DOES with a payload — the arithmetic, the
 * filter wiring and the failure rendering. `useJobsList` is captured rather than
 * stubbed blind so a test can assert the filters the page ASKED for, which is
 * where the query-vs-client-filtering bug would hide.
 */

const dashboardState = {
  data: null as JobsDashboardResponse | null,
  loading: false,
  refreshing: false,
  error: null as string | null,
  staleSince: null as Date | null,
  updatedAt: null as Date | null,
  refresh: vi.fn(),
};

const listState = {
  data: null as JobListResponse | null,
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
};

const historyState = {
  data: null as JobHistoryResponse | null,
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
};

const categoryHistoryState = {
  data: null as JobCategoryHistoryResponse | null,
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
};

// Same as `useDeadLetters` below: `useJobControls` reads the auth context that
// `renderWithProviders` deliberately does not supply. The card has its own test
// file; what the PAGE owes is mounting it and refreshing it with the rest.
const controlsState = {
  data: null as JobControlsResponse | null,
  loading: false,
  saving: false,
  error: null as string | null,
  refresh: vi.fn(),
  save: vi.fn(async () => true),
};

// `useDeadLetters` reads the auth context, which `renderWithProviders`
// deliberately does not supply (see its docblock). The card has its own test
// file; what the PAGE owes is mounting it and refreshing it with everything else.
const deadLetterState = {
  groups: [] as DeadLetterGroup[],
  total: 0,
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
  replay: vi.fn(async () => null),
};

/** Filters the page handed the list hook on its most recent render. */
let lastFilters: Record<string, unknown> = {};
/** Window (hours) the page handed the history hook. */
let lastWindowHours = 0;

// Same reason as `useDeadLetters` above: the pinned import region reads the
// auth context that `renderWithProviders` deliberately does not supply. It has
// its own test file; what the PAGE owes is mounting it, above Queue Activity.
vi.mock('@/components/ImportActivity', () => ({
  ImportActivity: ({ className }: { className?: string }) => <div className={className}>import activity</div>,
}));

vi.mock('./useJobsDashboard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useJobsDashboard')>();

  return { ...actual, useJobsDashboard: () => dashboardState };
});

vi.mock('./useJobsList', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useJobsList')>();

  return {
    ...actual,
    useJobsList: (filters: Record<string, unknown>) => {
      lastFilters = filters;

      return listState;
    },
  };
});

// The taxonomy hook talks to /api/jobs/types behind the auth provider; the page
// tests care about filter wiring, not the fetch, so it serves a fixed taxonomy.
vi.mock('./useJobTypes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useJobTypes')>();

  return {
    ...actual,
    useJobTypes: () => ({
      types: {
        categories: ['ingest', 'search'],
        types: {
          'file.uploaded': {
            label: 'File uploaded',
            category: 'ingest',
            description: '',
            interactive: false,
          },
        },
      },
      loading: false,
    }),
  };
});

vi.mock('./useDeadLetters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useDeadLetters')>();

  return { ...actual, useDeadLetters: () => deadLetterState };
});

vi.mock('./useJobControls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useJobControls')>();

  return { ...actual, useJobControls: () => controlsState };
});

vi.mock('./useJobHistory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useJobHistory')>();

  return {
    ...actual,
    useJobHistory: (hours: number) => {
      lastWindowHours = hours;

      return historyState;
    },
  };
});

// The category chart fetches on its own rather than taking a prop, so it needs
// its own stub — unmocked, it reaches the real `useJobsAuth`/`useAuth` and every
// test in this file dies on a missing provider, pointing at the summary card
// rather than at the chart that actually pulled it in.
//
// Spread from importOriginal(): an allow-list mock blanks the module's other
// exports for everything that reaches them transitively, which is how a type-only
// re-export goes missing in a way the failure message never mentions.
vi.mock('./useJobCategoryHistory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useJobCategoryHistory')>();

  return {
    ...actual,
    useJobCategoryHistory: () => categoryHistoryState,
  };
});

// Recharts measures its container, which jsdom reports as 0x0.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();

  return {
    ...actual,
    AreaChart: () => null,
    BarChart: () => null,
    LineChart: () => null,
  };
});

function job(overrides: Partial<JobListItem> = {}): JobListItem {
  return {
    id: 'job-1',
    queue: 'search-index',
    state: 'created',
    event: 'note.created',
    workType: null,
    label: 'note created',
    category: 'search',
    description: 'Index a new note for search',
    interactive: false,
    createdOn: '2026-08-17T00:00:00.000Z',
    startedOn: null,
    completedOn: null,
    durationMs: null,
    retryCount: 0,
    retryLimit: 3,
    payloadBytes: 120,
    failure: null,
    deadLettered: false,
    ...overrides,
  };
}

function list(overrides: Partial<JobListResponse> = {}): JobListResponse {
  return {
    items: [],
    total: 0,
    limit: 50,
    offset: 0,
    queues: ['search-index', 'image-description'],
    stateCounts: { created: 12716, failed: 821, 'dead-letter': 1191 },
    // Shaped like a real appliance: heavily skewed, several categories at zero,
    // and a non-empty `unclassified` bucket — the three cases the chip row has
    // to render sensibly.
    categoryCounts: { ingest: 5977, search: 2270, llm: 262, maintenance: 113, unclassified: 587 },
    ...overrides,
  };
}

function dashboard(overrides: Partial<JobsDashboardResponse> = {}): JobsDashboardResponse {
  return {
    summary: {
      pending: 12716,
      active: 12,
      retry: 3,
      completed: 115135,
      failed: 1191,
      cancelled: 0,
      deadLettered: 1191,
      scheduled: 0,
    },
    archiveDistribution: [],
    activeDistribution: [],
    queueDistribution: [],
    smartRotationDistribution: [],
    jobs: [],
    archive: [],
    schedules: [],
    crons: [],
    queues: [],
    ...overrides,
  };
}

function render(
  options: {
    dashboard?: JobsDashboardResponse;
    list?: JobListResponse;
    history?: JobHistoryResponse;
    staleSince?: Date | null;
    error?: string | null;
    deadLetters?: DeadLetterGroup[];
    /** Initial URL, so a test can assert that a link restores a view. */
    routerEntries?: string[];
  } = {},
) {
  Object.assign(dashboardState, {
    data: options.dashboard ?? dashboard(),
    loading: false,
    refreshing: false,
    error: options.error ?? null,
    staleSince: options.staleSince ?? null,
    updatedAt: new Date('2026-08-17T00:05:00.000Z'),
  });

  Object.assign(listState, { data: options.list ?? list(), loading: false, error: null });
  Object.assign(historyState, { data: options.history ?? null, loading: false, error: null });
  Object.assign(deadLetterState, {
    groups: options.deadLetters ?? [],
    total: (options.deadLetters ?? []).reduce((sum, group) => sum + group.count, 0),
    loading: false,
    error: null,
  });

  return renderWithProviders(<JobsPage />, { routerEntries: options.routerEntries ?? ['/jobs'] });
}

describe('JobsPage summary', () => {
  /**
   * Several labels ("Failed", "Dead-lettered") appear both as a summary tile and
   * as a state tab, so assertions here scope to the tile that carries the count.
   */
  function tile(label: string): HTMLElement {
    const heading = screen
      .getAllByText(label)
      .find((node) => node.className.includes('uppercase') && node.tagName === 'P');

    const button = heading?.closest('button');

    if (!button) {
      throw new Error(`No summary tile for "${label}"`);
    }

    return button;
  }

  it('reports pending and dead-lettered as separate figures', () => {
    render();

    // The same 1,191 jobs used to be counted under BOTH Pending and Failed,
    // because pg-boss parks a dead-lettered job in state `created`.
    expect(tile('Pending')).toHaveTextContent('12,716');
    expect(tile('Dead-lettered')).toHaveTextContent('1,191');
    expect(tile('Retrying')).toHaveTextContent('3');
  });

  it('makes each tile a shortcut into the table', () => {
    render();

    fireEvent.click(tile('Failed'));

    // A number an operator cannot click is a number they have to go hunting for.
    expect(lastFilters).toMatchObject({ state: 'failed', offset: 0 });
  });
});

describe('JobsPage table', () => {
  it('renders the taxonomy label and the raw event name for each job', () => {
    render({
      list: list({
        items: [job({ label: 'Generate chat reply', event: 'chat.generate' })],
        total: 1,
      }),
    });

    // "Generate chat reply" is the point: the raw `chat.generate`, and the queue
    // it happens to run on, say nothing about what the appliance is doing.
    expect(screen.getByText('Generate chat reply')).toBeInTheDocument();
    expect(screen.getByText('chat.generate')).toBeInTheDocument();
  });

  it('shows a failure message inline and its stack when the row is expanded', () => {
    render({
      list: list({
        items: [
          job({
            state: 'failed',
            label: 'File uploaded',
            failure: {
              message: 'Cannot find ffmpeg',
              stack: 'Error: Cannot find ffmpeg\n    at FfmpegCommand',
              failedAt: '2026-08-17T09:21:10.289Z',
            },
          }),
        ],
        total: 1,
      }),
    });

    expect(screen.getByText('Cannot find ffmpeg')).toBeInTheDocument();
    // Collapsed by default — stacks are long and most jobs never fail.
    expect(screen.queryByText(/at FfmpegCommand/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Details for File uploaded/ }));

    expect(screen.getByText(/at FfmpegCommand/)).toBeInTheDocument();
  });

  it('asks the server for the filters rather than filtering in the browser', () => {
    render();

    fireEvent.change(screen.getByLabelText('Search jobs'), { target: { value: 'ffmpeg' } });
    expect(lastFilters).toMatchObject({ search: 'ffmpeg', offset: 0 });

    // Category is a chip row, not a select. Scoped to its own tablist because
    // "Model" is a short word and the page is full of buttons.
    const categoryRow = screen.getByRole('tablist', { name: 'Job category' });
    fireEvent.click(within(categoryRow).getByRole('tab', { name: /Model/ }));
    expect(lastFilters).toMatchObject({ category: 'llm', offset: 0 });

    fireEvent.change(screen.getByLabelText('Queue'), { target: { value: 'image-description' } });
    expect(lastFilters).toMatchObject({ queue: 'image-description' });
  });

  it('restores a whole view from the URL, so a link is a place', () => {
    // Filters used to live in useState: a reload dropped you back to
    // "everything, page 1", and there was no way to hand anyone a view except a
    // screenshot and directions.
    render({ routerEntries: ['/jobs?state=failed&category=llm&queue=image-description&search=ffmpeg'] });

    expect(lastFilters).toMatchObject({
      state: 'failed',
      category: 'llm',
      queue: 'image-description',
      search: 'ffmpeg',
    });
  });

  it('writes a picked filter back into the query string', () => {
    render();

    const categoryRow = screen.getByRole('tablist', { name: 'Job category' });
    fireEvent.click(within(categoryRow).getByRole('tab', { name: /Planning/ }));

    // The URL mechanics themselves are covered in useJobFilters.test.tsx — the
    // harness runs a MemoryRouter, so window.location never moves. What this
    // asserts is that the page routes a chip click through the same state the
    // URL owns, rather than keeping a second copy beside it.
    expect(lastFilters).toMatchObject({ category: 'planning' });
  });

  it('keeps the page size out of the URL — it is a property of the device, not the view', () => {
    // A phone-sized link opened on a desktop must not stay phone-sized.
    render({ routerEntries: ['/jobs?state=failed'] });

    expect(lastFilters).toMatchObject({ limit: 50 });
  });

  it('offers every category as a toggle, carrying the count that picking it would yield', () => {
    render();

    const categoryRow = screen.getByRole('tablist', { name: 'Job category' });

    // All ten, plus the "All" reset and the unclassified bucket. A category with
    // no jobs still gets a chip — dropping it would make the row's shape shift
    // under the operator as work arrives, and "nothing here" is also an answer.
    for (const label of [
      'All',
      'Ingest',
      'Import / sync',
      'Pipeline',
      'Enrichment',
      'Search index',
      'Life graph',
      'Model',
      'Personalization',
      'Planning',
      'Maintenance',
      'Unclassified',
    ]) {
      expect(within(categoryRow).getByRole('tab', { name: new RegExp(label) })).toBeInTheDocument();
    }

    // The count comes from `categoryCounts`, which drops the category and type
    // filters — so it answers "what would picking this give me?".
    expect(within(categoryRow).getByRole('tab', { name: /Ingest/ })).toHaveTextContent('5,977');

    // The unclassified bucket is the taxonomy's own gap made visible and
    // clickable, rather than a silent shortfall between the chips and All.
    const unclassified = within(categoryRow).getByRole('tab', { name: /Unclassified/ });
    expect(unclassified).toHaveTextContent('587');

    fireEvent.click(unclassified);
    expect(lastFilters).toMatchObject({ category: 'unclassified', offset: 0 });
  });

  it('counts the category row\'s "All" over categories, not over the selected category', () => {
    render();

    const categoryRow = screen.getByRole('tablist', { name: 'Job category' });
    const stateRow = screen.getByRole('tablist', { name: 'Job state' });

    // The two rows answer different questions, so their "All" chips carry
    // different totals: the state row sums stateCounts (12,716 + 821 + 1,191),
    // the category row sums categoryCounts (5,977 + 2,270 + 262 + 113 + 587).
    // Using the state total here made the category row read "All 268 … Ingest
    // 5,977" once a category was picked — the part larger than the whole.
    expect(within(categoryRow).getByRole('tab', { name: /^All/ })).toHaveTextContent('9,209');
    expect(within(stateRow).getByRole('tab', { name: /^All/ })).toHaveTextContent('14,728');
  });

  it('labels each filter row so two rows of pills are not just two rows of pills', () => {
    render();

    // Both chip rows start with a chip called "All", so without a label the
    // only way to tell state from category is to recognise the words in them.
    for (const label of ['State', 'Category', 'Find']) {
      expect(screen.getByText(label, { selector: 'span' })).toBeInTheDocument();
    }
  });

  it('clears a job type when the category changes, so the pair cannot match nothing', () => {
    render();

    const categoryRow = screen.getByRole('tablist', { name: 'Job category' });

    fireEvent.change(screen.getByLabelText('Job type'), { target: { value: 'file.uploaded' } });
    expect(lastFilters).toMatchObject({ type: 'file.uploaded' });

    fireEvent.click(within(categoryRow).getByRole('tab', { name: /Planning/ }));
    expect(lastFilters).toMatchObject({ category: 'planning', type: '', offset: 0 });
  });

  it('labels a dead-lettered row as such rather than as waiting work', () => {
    render({
      list: list({
        items: [job({ queue: 'dead-letter', state: 'created', deadLettered: true })],
        total: 1,
      }),
    });

    // Its state column says `created`; calling that "waiting" is the bug.
    expect(screen.getByText('dead-lettered')).toBeInTheDocument();
  });

  it('carries per-state counts on the tabs', () => {
    render();

    const tab = screen.getByRole('tab', { name: /Dead-lettered/ });

    expect(within(tab).getByText('1,191')).toBeInTheDocument();
  });

  it('pages through results without re-running the search', () => {
    render({ list: list({ items: [job()], total: 500 }) });

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(lastFilters).toMatchObject({ offset: 50 });
  });
});

describe('JobsPage history', () => {
  it('defaults to a 24-hour window and lets it be changed', () => {
    render();

    expect(lastWindowHours).toBe(24);

    fireEvent.click(screen.getByRole('button', { name: '7d' }));

    expect(lastWindowHours).toBe(24 * 7);
  });

  it('explains an empty chart instead of drawing nothing', () => {
    render({ history: { points: [], queues: [], bucketMinutes: 5, windowHours: 24 } });

    expect(screen.getByText(/No history recorded yet/)).toBeInTheDocument();
  });
});

describe('JobsPage schedules', () => {
  it('lists the recurring jobs from the live scheduler registry', () => {
    render({
      dashboard: dashboard({
        crons: [
          {
            name: 'PipelineTickCron.tick',
            cron: '0 */2 * * * *',
            timezone: null,
            running: true,
            nextRunAt: '2026-08-17T01:00:00.000Z',
            lastRunAt: null,
            lastSuccessAt: null,
            overdue: false,
          },
        ],
      }),
    });

    // `pgboss.schedule` is empty on every appliance — nothing calls
    // boss.schedule(). These come from Nest's registry instead.
    //
    // Shown the way the Jobs table shows a job: the readable name, not the raw
    // registration key. Crons register as `ClassName.methodName` (and used to
    // register as a bare UUID), which told an operator nothing.
    // The CLASS names the job when the method is generic — `tick` alone told an
    // operator nothing, and eight crons registered as `.run`.
    expect(screen.getByText('Pipeline tick')).toBeInTheDocument();
    // The schedule reads as words, not as six positional fields — and the raw
    // expression stays on the cell's title, because that is the form you paste
    // back into an @Cron decorator.
    expect(screen.getByText('Every 2 min')).toBeInTheDocument();
    expect(screen.getAllByTitle('0 */2 * * * *').length).toBeGreaterThan(0);
    // The registration key stays reachable for anyone grepping the codebase.
    expect(screen.getByTitle('PipelineTickCron.tick')).toBeInTheDocument();
  });

  it('prefers the taxonomy label when a cron maps to a known event', () => {
    render({
      dashboard: dashboard({
        crons: [
          {
            name: 'file.uploaded',
            cron: '0 * * * * *',
            timezone: null,
            running: true,
            nextRunAt: null,
            lastRunAt: null,
            lastSuccessAt: null,
            overdue: false,
          },
        ],
      }),
    });

    // Same label the Jobs table gives that event — one vocabulary across both.
    // Scoped to the schedule entry: the label also appears as an <option> in the
    // job-type filter, which is the point — both read from one taxonomy.
    expect(screen.getByTitle('file.uploaded')).toHaveTextContent('File uploaded');
  });

  /** The schedule row a registration key identifies, label and category included. */
  function scheduleRow(name: string): HTMLElement {
    const row = screen.getByTitle(name).closest('tr');

    if (!row) {
      throw new Error(`No schedule row for "${name}"`);
    }

    return row;
  }

  function cron(
    name: string,
    overrides: Partial<JobsDashboardResponse['crons'][number]> = {},
  ): JobsDashboardResponse['crons'][number] {
    return {
      name,
      cron: '0 0 * * * *',
      timezone: null,
      running: true,
      nextRunAt: null,
      lastRunAt: null,
      lastSuccessAt: null,
      overdue: false,
      ...overrides,
    };
  }

  it('files the planning schedules under Planning, not Maintenance', () => {
    render({
      dashboard: dashboard({
        crons: [cron('PlanningJobsCron.todoScan'), cron('PlanningJobsCron.verifyDone')],
      }),
    });

    // Plan automation used to render as "Maintenance" — the category an operator
    // scrolls past — because no rule matched and the default swallowed it.
    expect(scheduleRow('PlanningJobsCron.todoScan')).toHaveTextContent('Planning');
    expect(scheduleRow('PlanningJobsCron.verifyDone')).toHaveTextContent('Planning');
  });

  it('reads two schedules on one collector as that collector doing two things', () => {
    render({
      dashboard: dashboard({
        crons: [cron('JobMetricsCollector.sampleOnSchedule'), cron('JobMetricsCollector.purgeOnSchedule')],
      }),
    });

    // "Job metrics" beside "Purge on schedule" looked like two unrelated jobs,
    // and the purge never said what it purges.
    expect(scheduleRow('JobMetricsCollector.sampleOnSchedule')).toHaveTextContent('Job metrics sample');
    expect(scheduleRow('JobMetricsCollector.purgeOnSchedule')).toHaveTextContent('Job metrics purge');
  });

  it('marks a scheduler-minted name as the backend bug it is', () => {
    const uuid = '007c9ac0-fb23-4203-809b-c2d100b373e4';

    render({ dashboard: dashboard({ crons: [cron(uuid)] }) });

    // A UUID here means the @Cron has no `name`, so the key changes on every
    // boot and nothing durable can find the job. The page used to render the
    // UUID as a name under an invented category and say nothing.
    const row = scheduleRow(uuid);

    expect(within(row).getByText('needs a name')).toBeInTheDocument();
    expect(row).toHaveTextContent('Unclassified');
    expect(row).toHaveTextContent(uuid);
  });

  it('leaves a named schedule unmarked', () => {
    render({ dashboard: dashboard({ crons: [cron('PipelineTickCron.runOnSchedule')] }) });

    expect(screen.queryByText('needs a name')).not.toBeInTheDocument();
  });

  it('calls a schedule overdue instead of reporting it as scheduled', () => {
    render({
      dashboard: dashboard({
        crons: [
          cron('DerivationCron.deriveNightly', {
            lastRunAt: '2026-08-14T00:00:00.000Z',
            lastSuccessAt: '2026-08-14T00:00:00.000Z',
            overdue: true,
          }),
          cron('PipelineTickCron.runOnSchedule'),
        ],
      }),
    });

    // `running` is what this column used to read, and it stays true for a
    // schedule that has missed every fire for days — the @Cron wrapper catches
    // and returns — so "scheduled" was the one thing it could never stop saying.
    const late = scheduleRow('DerivationCron.deriveNightly');

    expect(within(late).getByText('overdue')).toBeInTheDocument();
    expect(within(late).queryByText('scheduled')).not.toBeInTheDocument();

    const healthy = scheduleRow('PipelineTickCron.runOnSchedule');

    expect(within(healthy).getByText('scheduled')).toBeInTheDocument();
    expect(within(healthy).queryByText('overdue')).not.toBeInTheDocument();
  });

  it('shows when a schedule last succeeded, not only when it last fired', () => {
    const attemptedAt = new Date('2026-08-17T00:04:00.000Z');
    const succeededAt = new Date('2026-08-16T02:00:00.000Z');

    render({
      dashboard: dashboard({
        crons: [
          cron('OrphanCleanupCron.sweepOnSchedule', {
            lastRunAt: attemptedAt.toISOString(),
            lastSuccessAt: succeededAt.toISOString(),
          }),
        ],
      }),
    });

    // The attempt stamp lands BEFORE the body, so "last run four minutes ago" is
    // equally true of a job that has completed nothing since yesterday. Only the
    // second cell separates the two.
    const row = scheduleRow('OrphanCleanupCron.sweepOnSchedule');

    expect(within(row).getByText(attemptedAt.toLocaleTimeString())).toBeInTheDocument();
    expect(within(row).getByText(succeededAt.toLocaleTimeString())).toBeInTheDocument();
  });

  it('separates a schedule that has never completed a tick from one that never ran', () => {
    render({
      dashboard: dashboard({
        crons: [
          cron('FeedQueueCron.topUpFeedQueue', { lastRunAt: '2026-08-17T00:04:00.000Z' }),
          cron('AskExpiryCron.expireOverdueAsks'),
        ],
      }),
    });

    // Firing on time and failing every time is the state both "scheduled" and
    // "last run" report as healthy, so it gets a word rather than a dash.
    expect(within(scheduleRow('FeedQueueCron.topUpFeedQueue')).getByText('never')).toBeInTheDocument();
    expect(
      within(scheduleRow('AskExpiryCron.expireOverdueAsks')).queryByText('never'),
    ).not.toBeInTheDocument();
  });
});

describe('JobsPage staleness', () => {
  it('says so when refreshes are failing behind still-displayed data', () => {
    render({ staleSince: new Date('2026-08-17T00:05:00.000Z'), error: 'Failed to fetch' });

    const status = screen.getByRole('status');

    expect(status).toHaveTextContent(/refreshes have been failing/i);
    expect(status).toHaveTextContent(/Failed to fetch/);
  });

  it('shows a plain error when the very first load fails', () => {
    Object.assign(dashboardState, { data: null, error: 'Network down', staleSince: null });
    Object.assign(listState, { data: null, loading: false, error: null });
    Object.assign(historyState, { data: null, loading: false, error: null });

    renderWithProviders(<JobsPage />);

    expect(screen.getByRole('alert')).toHaveTextContent('Network down');
  });
});

describe('JobsPage dead letters', () => {
  /**
   * `ci.pipeline_dead_letters` is a DIFFERENT table from the `pgboss.job` rows
   * the rest of this page reads: pg-boss archives and eventually deletes its
   * rows, while a dead letter keeps the payload forever so the work can be
   * re-run. Before this card nothing in the product read it at all.
   */
  const group = (overrides: Partial<DeadLetterGroup> = {}): DeadLetterGroup => ({
    key: 'infer.question.answer Invalid model specified: qwen/qwen3-vl-30b',
    eventName: 'infer.question.answer',
    error: 'Invalid model specified: qwen/qwen3-vl-30b',
    detail: 'Invalid model specified: qwen/qwen3-vl-30b\n    at OllamaService.validateModel',
    count: 36,
    ids: Array.from({ length: 36 }, (_, i) => `letter-${i}`),
    firstFailedAt: new Date('2026-08-17T00:00:00.000Z').getTime(),
    lastFailedAt: new Date('2026-08-18T14:49:12.525Z').getTime(),
    ...overrides,
  });

  it('mounts the dead-letter card with its causes', () => {
    render({ deadLetters: [group()] });

    expect(screen.getByText('Dead letters')).toBeInTheDocument();
    expect(screen.getByText('Invalid model specified: qwen/qwen3-vl-30b')).toBeInTheDocument();
    expect(screen.getByText(/36 un-replayed across 1 cause/)).toBeInTheDocument();
  });

  it('refreshes dead letters along with everything else', () => {
    render({ deadLetters: [group()] });

    deadLetterState.refresh.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));

    expect(deadLetterState.refresh).toHaveBeenCalled();
  });
});

/**
 * The controls the page grew: turn a job off, cap how hard the box works.
 *
 * The card has its own test file. What the PAGE owes it is being findable from
 * the counts that send someone looking for it — "something is pegging this box"
 * is answered by the tiles and acted on in Controls, and a control four cards
 * further down is one an operator reaches for after they have already restarted
 * the appliance.
 */
describe('JobsPage controls', () => {
  it('mounts the controls card under the summary', () => {
    render();

    const controls = screen.getByText('Controls');
    const summary = screen.getByText('Queue Activity');

    expect(controls).toBeInTheDocument();
    // DOCUMENT_POSITION_FOLLOWING: the summary comes before the controls.
    expect(summary.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('refreshes the controls along with everything else', () => {
    render();

    controlsState.refresh.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));

    expect(controlsState.refresh).toHaveBeenCalled();
  });

  it('reports a schedule the operator switched off as off, not as scheduled', () => {
    render({
      dashboard: dashboard({
        crons: [
          {
            name: 'PythonFunctionCrons.hbpeNightly',
            cron: '0 0 3 * * *',
            timezone: null,
            running: true,
            nextRunAt: '2026-08-18T03:00:00.000Z',
            lastRunAt: '2026-08-17T03:00:00.000Z',
            lastSuccessAt: '2026-08-17T03:00:00.000Z',
            overdue: false,
            disabled: true,
          },
        ],
      }),
    });

    // The scheduler still holds it and `nextRunAt` still advances, so without
    // this the row would say "scheduled" for a job that will not run — exactly
    // the silent failure the Controls card must not be able to create.
    expect(screen.getByText('off')).toBeInTheDocument();
    expect(screen.queryByText('scheduled')).not.toBeInTheDocument();
  });
});

/**
 * Refreshing, by gesture and by button.
 *
 * The page had no swipe-down at all while People, Places and the Memory list
 * all had one, and its Refresh button gave back nothing to look at — on a
 * dashboard whose slowest card is the whole reason someone reached for it.
 */
describe('JobsPage refresh', () => {
  beforeEach(() => {
    for (const state of [dashboardState, listState, historyState, deadLetterState]) {
      state.refresh.mockReset();
    }
  });

  afterEach(() => {
    setViewport(false);
    Object.assign(dashboardState, { refreshing: false });
  });

  it('refreshes every card on a swipe down', async () => {
    setViewport(true);
    render();

    await screen.findByTestId('pull-to-refresh');

    const scroller = document.querySelector('[data-page-scroll]');

    if (!(scroller instanceof HTMLElement)) {
      throw new Error('Jobs has no page scroller for the gesture to hang off');
    }

    fireEvent.touchStart(scroller, { touches: [{ identifier: 0, clientY: 10 }] });
    fireEvent.touchMove(scroller, { touches: [{ identifier: 0, clientY: 160 }] });
    fireEvent.touchEnd(scroller);

    await waitFor(() => expect(dashboardState.refresh).toHaveBeenCalled());
    expect(listState.refresh).toHaveBeenCalled();
    expect(historyState.refresh).toHaveBeenCalled();
    expect(deadLetterState.refresh).toHaveBeenCalled();
  });

  it('holds the gesture spinner until every card has answered', async () => {
    setViewport(true);

    let settle = () => {};

    dashboardState.refresh.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );

    render();

    await screen.findByTestId('pull-to-refresh');

    const scroller = document.querySelector('[data-page-scroll]') as HTMLElement;

    fireEvent.touchStart(scroller, { touches: [{ identifier: 0, clientY: 10 }] });
    fireEvent.touchMove(scroller, { touches: [{ identifier: 0, clientY: 160 }] });
    fireEvent.touchEnd(scroller);

    // A `refreshAll` that returned void — which is what it did — flashed this
    // away on the next frame, which on a phone is indistinguishable from a
    // gesture that was never wired up.
    await waitFor(() => expect(screen.getByTestId('pull-to-refresh')).toHaveAttribute('aria-busy', 'true'));

    await act(async () => {
      settle();
    });

    await waitFor(() => expect(screen.getByTestId('pull-to-refresh')).not.toHaveAttribute('aria-busy'));
  });

  it('spins the button while a refresh runs and leaves the figures up', async () => {
    let settle = () => {};

    dashboardState.refresh.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );

    render();

    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));

    const button = screen.getByRole('button', { name: /Refresh/ });

    expect(button).toHaveAttribute('aria-busy', 'true');
    // The whole point of #2320: the previous snapshot never leaves the screen.
    expect(screen.getAllByText('12,716').length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => {
      settle();
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Refresh/ })).not.toHaveAttribute('aria-busy'),
    );
  });

  it('reports the mount refetch behind a restored snapshot as a spinner, not a skeleton', () => {
    // What a revisit looks like: cached figures already on screen, and a fetch
    // in flight underneath them. `loading` — which draws the skeleton — is
    // false precisely because there is something to show.
    Object.assign(dashboardState, {
      data: dashboard(),
      loading: false,
      refreshing: true,
      error: null,
      staleSince: null,
      updatedAt: new Date('2026-08-17T00:05:00.000Z'),
    });
    Object.assign(listState, { data: list(), loading: false, error: null });
    Object.assign(historyState, { data: null, loading: false, error: null });
    Object.assign(deadLetterState, { groups: [], total: 0, loading: false, error: null });

    renderWithProviders(<JobsPage />);

    expect(screen.getByRole('button', { name: /Refresh/ })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getAllByText('12,716').length).toBeGreaterThan(0);
  });
});

/**
 * The import an operator is actually asking about.
 *
 * This page answers "what is the queue doing" in pg-boss's own terms, and on a
 * live 13-source import that read `import-stages: 142 created, 1 active` — a
 * number that is not even the backlog, because a redelivered stage job is a
 * deliberate no-op and leaves its row behind (those 142 rows covered 19
 * distinct stages). Nothing here said which archive was importing, how far
 * along it was, or which stage had been waiting an hour.
 */
describe('JobsPage live imports', () => {
  it('pins import progress above the queue summary', () => {
    renderWithProviders(<JobsPage />);

    const activity = screen.getByText('import activity');

    expect(activity).toBeInTheDocument();
    // Above Queue Activity: while an import is in flight it outranks the raw
    // queue, which is the thing an operator came here unable to interpret.
    expect(
      activity.compareDocumentPosition(screen.getByText('Queue Activity')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('lets the region size to its content, unlike the import surface', () => {
    // The import surface caps it, because that column is bounded and the wizard
    // has to keep its share. This page scrolls, so a cap here would only hide
    // the runs an operator opened the page to read. Asserted so the two hosts
    // cannot quietly converge on one wrong answer.
    renderWithProviders(<JobsPage />);

    expect(screen.getByText('import activity').className).toBe('');
  });
});

function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width') ? mobile : query.includes('landscape') ? !mobile : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe('JobsPage phone layout', () => {
  afterEach(() => setViewport(false));

  function title(name: string): HTMLElement {
    const node = screen.getByText(name, { selector: '[data-slot="card-title"]' });

    return node;
  }

  it('renders jobs as cards and keeps the wide table off the phone', async () => {
    setViewport(true);
    render({
      list: list({
        items: [job({ label: 'Generate chat reply', event: 'chat.generate' })],
        total: 1,
      }),
    });

    await waitFor(() => {
      expect(screen.queryByRole('columnheader', { name: 'Duration' })).not.toBeInTheDocument();
    });

    expect(screen.getByText('Generate chat reply')).toBeInTheDocument();
    expect(screen.getByText(/chat\.generate/)).toBeInTheDocument();
  });

  it('asks the server for a shorter page so a phone is a scan, not a novel', async () => {
    setViewport(true);
    render({ list: list({ items: [job()], total: 500 }) });

    await waitFor(() => expect(lastFilters).toMatchObject({ limit: 20 }));
  });

  it('puts live work first and dead letters last', async () => {
    setViewport(true);
    render();

    await waitFor(() => {
      expect(screen.queryByRole('columnheader', { name: 'Duration' })).not.toBeInTheDocument();
    });

    const jobs = title('Jobs');
    const history = title('History');
    const schedules = title('Schedules');
    const dead = title('Dead letters');

    expect(jobs.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(history.compareDocumentPosition(schedules) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(schedules.compareDocumentPosition(dead) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('folds history, schedules and dead letters so the page is scrollable', async () => {
    setViewport(true);
    render({ history: { points: [], queues: [], bucketMinutes: 5, windowHours: 24 } });

    await waitFor(() => {
      expect(screen.queryByRole('columnheader', { name: 'Duration' })).not.toBeInTheDocument();
    });

    // Closed until opened — three stacked charts and ~34 schedules would
    // push Jobs off a phone that already has a bottom nav.
    expect(screen.queryByRole('button', { name: '7d' })).not.toBeInTheDocument();
    expect(screen.queryByText(/No history recorded yet/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /History/ }));

    expect(screen.getByRole('button', { name: '7d' })).toBeInTheDocument();
    expect(screen.getByText(/No history recorded yet/)).toBeInTheDocument();
  });

  it('caps import activity on this page only, so Jobs stays reachable', async () => {
    setViewport(true);
    renderWithProviders(<JobsPage />);

    await waitFor(() => {
      expect(screen.getByText('import activity').className).toContain('max-h-[36vh]');
    });
  });

  it('carries the unnamed-cron warning into the phone list', async () => {
    setViewport(true);
    render({
      dashboard: dashboard({
        crons: [
          {
            name: '007c9ac0-fb23-4203-809b-c2d100b373e4',
            cron: '0 0 * * * *',
            timezone: null,
            running: true,
            nextRunAt: null,
            lastRunAt: null,
            lastSuccessAt: null,
            overdue: false,
          },
        ],
      }),
    });

    await waitFor(() => {
      expect(screen.queryByRole('columnheader', { name: 'Duration' })).not.toBeInTheDocument();
    });

    // The phone list is a separate renderer from the table, so it gets the same
    // assertion rather than being assumed to have kept up.
    // Scoped: the Health card can also offer a "View schedules" action, and an
    // unscoped getByRole('button') would find both and fail pointing at the
    // wrong component.
    fireEvent.click(screen.getByRole('button', { name: /^Schedules/ }));

    // Scoped to the schedules list. The Health card also names categories (its
    // legend filters by them), so an unscoped getByRole would match both and
    // fail pointing at the wrong component.
    const scheduleList = screen.getByRole('group', { name: 'Schedules by category' });
    fireEvent.click(within(scheduleList).getByRole('button', { name: /Unclassified/ }));

    expect(screen.getByText('needs a name')).toBeInTheDocument();
  });

  it('carries overdue and last-succeeded into the phone list', async () => {
    setViewport(true);
    render({
      dashboard: dashboard({
        crons: [
          {
            name: 'FeedQueueCron.topUpFeedQueue',
            cron: '0 0 * * * *',
            timezone: null,
            running: true,
            nextRunAt: null,
            lastRunAt: '2026-08-14T00:00:00.000Z',
            lastSuccessAt: null,
            overdue: true,
          },
        ],
      }),
    });

    await waitFor(() => {
      expect(screen.queryByRole('columnheader', { name: 'Duration' })).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /^Schedules/ }));

    const scheduleList = screen.getByRole('group', { name: 'Schedules by category' });
    fireEvent.click(within(scheduleList).getByRole('button', { name: /Maintenance/ }));

    expect(screen.getByText('overdue')).toBeInTheDocument();
    expect(screen.queryByText('scheduled')).not.toBeInTheDocument();
    expect(screen.getByText(/succeeded never/)).toBeInTheDocument();
  });
});
