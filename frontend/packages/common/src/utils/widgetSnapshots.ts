export const WIDGET_SNAPSHOT_VERSION = 1 as const;
const MAX_WIDGET_COUNT = 1_000_000_000;
const MAX_WIDGET_KILOMETERS = 1_000_000_000;

export interface WidgetTask {
  id: string;
  title: string;
  dueAt: string | null;
}

export interface CompanionWidgetSnapshot {
  version: typeof WIDGET_SNAPSHOT_VERSION;
  generatedAt: string;
  plan: {
    openCount: number;
    tasks: WidgetTask[];
    updatedAt: string | null;
  };
  insight: {
    systemStatus: string;
    stillLearning: boolean;
    prediction: string | null;
    confidence: number | null;
    forecastGeneratedAt: string | null;
    metricsUpdatedAt: string | null;
    messages: number;
    places: number;
    kilometers: number;
  };
  jobs: {
    pending: number;
    active: number;
    failed: number;
    deadLettered: number;
    completed: number;
    updatedAt: string | null;
  };
}

export interface WidgetAction {
  id: string;
  type: 'completeTask';
  taskId: string;
  createdAt: string;
}

export interface WidgetSnapshotInput {
  tasks?: readonly {
    id?: unknown;
    title?: unknown;
    status?: unknown;
    dueAt?: unknown;
    scheduledFor?: unknown;
  }[];
  forecast?: {
    generatedAt?: unknown;
    systemStatus?: unknown;
    stillLearning?: unknown;
    buckets?: readonly {
      startTime?: unknown;
      predictedL0?: unknown;
      l0Probs?: readonly { label?: unknown; probability?: unknown }[];
    }[];
  } | null;
  metrics?: readonly {
    nMessages?: unknown;
    nPlaces?: unknown;
    kmTraveled?: unknown;
  }[];
  jobs?: {
    summary?: {
      pending?: unknown;
      active?: unknown;
      failed?: unknown;
      deadLettered?: unknown;
      completed?: unknown;
    };
  } | null;
  tasksUpdatedAt?: unknown;
  metricsUpdatedAt?: unknown;
  jobsUpdatedAt?: unknown;
  now?: Date;
}

function safeLabel(value: unknown, maxLength = 72): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const cleaned = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

  return cleaned || null;
}

function safeDate(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
  }

  const date = new Date(value);

  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(MAX_WIDGET_COUNT, Math.floor(value))
    : 0;
}

function kilometers(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(MAX_WIDGET_KILOMETERS, Math.round(value * 10) / 10)
    : 0;
}

/**
 * Reduce live server responses to the small, content-limited payload widgets need.
 * The snapshot intentionally contains no notes, media URLs, credentials, or job payloads.
 */
export function buildWidgetSnapshot(input: WidgetSnapshotInput): CompanionWidgetSnapshot {
  const now = input.now ?? new Date();
  const tasks = (input.tasks ?? [])
    .filter((task) => typeof task.id === 'string' && task.id.length > 0 && task.id.length <= 256)
    .filter((task) => !['done', 'skipped', 'archived', 'cancelled'].includes(String(task.status ?? '').toLowerCase()))
    .map((task) => ({
      id: task.id as string,
      title: safeLabel(task.title, 72) ?? 'Untitled task',
      dueAt: safeDate(task.dueAt) ?? safeDate(task.scheduledFor),
    }))
    .sort((left, right) => {
      if (left.dueAt === null && right.dueAt !== null) return 1;
      if (left.dueAt !== null && right.dueAt === null) return -1;
      if (left.dueAt && right.dueAt) return left.dueAt.localeCompare(right.dueAt);

      return left.title.localeCompare(right.title);
    })
    .slice(0, 3);

  const forecastBucket =
    input.forecast?.buckets?.find((bucket) => {
      const startTime = safeDate(bucket.startTime);
      return startTime !== null && new Date(startTime).getTime() >= now.getTime();
    }) ?? input.forecast?.buckets?.[0];
  const prediction = safeLabel(forecastBucket?.predictedL0, 48);
  const matchingProbability =
    forecastBucket?.l0Probs?.find((entry) => entry.label === prediction)?.probability ?? null;
  const probabilityEntries = (forecastBucket?.l0Probs ?? [])
    .filter((entry) => typeof entry.probability === 'number' && Number.isFinite(entry.probability))
    .map((entry) => Math.max(0, Math.min(1, entry.probability as number)));
  const confidenceValue =
    typeof matchingProbability === 'number' && Number.isFinite(matchingProbability)
      ? matchingProbability
      : probabilityEntries.length > 0
        ? Math.max(...probabilityEntries)
        : null;

  const metricTotals = (input.metrics ?? []).reduce(
    (totals, row) => ({
      messages: Math.min(MAX_WIDGET_COUNT, totals.messages + count(row.nMessages)),
      places: Math.min(MAX_WIDGET_COUNT, totals.places + count(row.nPlaces)),
      kilometers: Math.min(MAX_WIDGET_KILOMETERS, totals.kilometers + kilometers(row.kmTraveled)),
    }),
    { messages: 0, places: 0, kilometers: 0 },
  );
  const openTaskCount = (input.tasks ?? []).filter(
    (task) => !['done', 'skipped', 'archived', 'cancelled'].includes(String(task.status ?? '').toLowerCase()),
  ).length;
  const jobSummary = input.jobs?.summary;
  const generatedAt = now.toISOString();
  const forecastGeneratedAt = safeDate(input.forecast?.generatedAt);

  return {
    version: WIDGET_SNAPSHOT_VERSION,
    generatedAt,
    plan: {
      openCount: Math.min(MAX_WIDGET_COUNT, openTaskCount),
      tasks,
      updatedAt: input.tasks ? safeDate(input.tasksUpdatedAt) ?? generatedAt : null,
    },
    insight: {
      systemStatus: safeLabel(input.forecast?.systemStatus, 32) ?? 'UNKNOWN',
      stillLearning: input.forecast?.stillLearning === true,
      prediction,
      confidence: confidenceValue === null ? null : Math.max(0, Math.min(1, confidenceValue)),
      forecastGeneratedAt,
      metricsUpdatedAt: input.metrics ? safeDate(input.metricsUpdatedAt) ?? generatedAt : null,
      messages: metricTotals.messages,
      places: metricTotals.places,
      kilometers: Math.round(metricTotals.kilometers * 10) / 10,
    },
    jobs: {
      pending: count(jobSummary?.pending),
      active: count(jobSummary?.active),
      failed: count(jobSummary?.failed),
      deadLettered: count(jobSummary?.deadLettered),
      completed: count(jobSummary?.completed),
      updatedAt: jobSummary ? safeDate(input.jobsUpdatedAt) ?? generatedAt : null,
    },
  };
}

/** Accept only the fixed widget destinations. Never route an arbitrary URL path. */
export function parseWidgetDestination(rawUrl: string): 'plan' | 'ask' | 'questions' | 'stats' | 'jobs' | null {
  try {
    const url = new URL(rawUrl);

    if (
      url.protocol !== 'companion:' ||
      url.hostname !== 'widget' ||
      url.port !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return null;
    }

    const route = url.pathname.slice(1);

    return route === 'plan' || route === 'ask' || route === 'questions' || route === 'stats' || route === 'jobs'
      ? route
      : null;
  } catch {
    return null;
  }
}
