import type { JobFilters } from './useJobsList';

/**
 * What the Jobs page should SAY, rather than what it should show.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * The page reported state accurately and diagnosed nothing. Six cards of correct
 * numbers, and the reader assembles the conclusion. On the appliance this was
 * written against, 8,431 of 19,606 jobs had exhausted every retry and stopped —
 * 43% of everything on the box — and that fact appeared as one tab label, at the
 * same visual weight as "Retrying 2".
 *
 * A verdict is a sentence with a number in it and somewhere to go. Anything that
 * cannot be phrased that way is a statistic and belongs in a chart.
 *
 * ── The rule that keeps it honest ──────────────────────────────────────────
 *
 * Every verdict carries the filter that PRODUCED it, and the UI renders that as
 * its action. A claim you cannot click into is an assertion; one you can is
 * evidence. It also means a verdict can never drift from the table — clicking it
 * runs the query the sentence was computed from, so a wrong verdict is
 * immediately visible as a mismatch rather than quietly wrong forever.
 */
export type VerdictTone = 'critical' | 'warning' | 'ok';

export interface JobVerdict {
  readonly id: string;
  readonly tone: VerdictTone;
  /** One sentence. Leads with the number, because that is what is being claimed. */
  readonly headline: string;
  /** The supporting clause. Kept separate so the UI can de-emphasise it. */
  readonly detail?: string;
  /** The filter that produced this sentence, or null when there is nothing to show. */
  readonly filter: Partial<JobFilters> | null;
  readonly action?: string;
  /**
   * When set, the Health card offers Clear — permanently delete these terminal
   * rows from `pgboss.job` via `POST /jobs/clear`.
   */
  readonly clearScope?: 'dead-letter' | 'failed';
}

export interface VerdictInput {
  readonly stateCounts: Readonly<Record<string, number>>;
  readonly categoryCounts: Readonly<Record<string, number>>;
  /** Schedules, for the "fired and never succeeded" signal. */
  readonly crons?: ReadonlyArray<{
    readonly name: string;
    readonly overdue?: boolean;
    readonly lastRunAt?: string | null;
    readonly lastSuccessAt?: string | null;
  }>;
}

/**
 * Read the appliance and say what is true, worst first.
 *
 * Deliberately returns an EMPTY list rather than a reassuring one when nothing
 * is known yet — a page that says "all healthy" while it is still loading has
 * lied once and cannot be trusted afterwards.
 */
export function jobVerdicts(input: VerdictInput): JobVerdict[] {
  const { stateCounts, categoryCounts, crons = [] } = input;

  const total = Object.values(stateCounts).reduce((sum, n) => sum + n, 0);

  if (total === 0) {
    return [];
  }

  const deadLettered = stateCounts['dead-letter'] ?? 0;
  const failed = stateCounts.failed ?? 0;
  const pending = stateCounts.created ?? 0;
  const active = stateCounts.active ?? 0;
  const retry = stateCounts.retry ?? 0;
  const unclassified = categoryCounts.unclassified ?? 0;

  const verdicts: JobVerdict[] = [];

  // ── Mass failure ────────────────────────────────────────────────────────
  // The single most important thing this page can tell anyone, and the thing it
  // used to render as a tab label.
  if (deadLettered > 0) {
    verdicts.push({
      id: 'dead-lettered',
      tone: deadLettered / total >= 0.1 ? 'critical' : 'warning',
      headline: `${deadLettered.toLocaleString()} ${deadLettered === 1 ? 'job has' : 'jobs have'} given up.`,
      // No percentage, and no cause.
      //
      // The percentage used to read "N% of everything on this appliance" over
      // `sum(stateCounts)`. That denominator is not comparable to the numerator:
      // the dead-letter queue keeps 30 days while pg-boss deletes completed and
      // failed rows after `deleteAfterHours`, and a job that exhausted its
      // retries is counted TWICE in it — once as the `failed` origin, once as
      // the dead-letter copy. The ratio was a 30-day pile over a half-day
      // window, understating worst exactly during the mass failure this verdict
      // exists to announce.
      //
      // The cause used to read "Most of it is <category>", taken from the
      // largest bucket in `categoryCounts` — which counts EVERY state, so it
      // named the busiest category on the box, not the one that was failing. On
      // an appliance that is 70% ingest and failing entirely on llm, it blamed
      // ingest. Naming the real one needs category counts scoped to
      // dead-lettered rows, which the API does not return yet.
      detail: 'Retries are exhausted — nothing retries a dead letter on its own.',
      filter: { state: 'dead-letter', offset: 0 },
      action: 'Show',
      clearScope: 'dead-letter',
    });
  }

  // ── Backlog ─────────────────────────────────────────────────────────────
  // Pending is only alarming next to how much is moving. A queue with work and
  // nothing running is stuck; a queue with work and workers is just busy.
  if (pending > 0 && active === 0) {
    verdicts.push({
      id: 'stalled',
      tone: 'critical',
      headline: `${pending.toLocaleString()} ${pending === 1 ? 'job is' : 'jobs are'} waiting with nothing running.`,
      detail: 'Work is queued but no worker has picked it up. Check that the worker process is alive.',
      filter: { state: 'created', offset: 0 },
      action: 'Show',
    });
  } else if (pending > 0) {
    verdicts.push({
      id: 'backlog',
      tone: 'warning',
      headline: `${pending.toLocaleString()} ${pending === 1 ? 'job is' : 'jobs are'} waiting.`,
      detail: `${active.toLocaleString()} running.`,
      filter: { state: 'created', offset: 0 },
      action: 'Show',
    });
  }

  // ── Retrying, and failed ────────────────────────────────────────────────
  // These were one verdict that said the opposite of the truth. pg-boss parks a
  // job with attempts LEFT in state `retry`; `failed` is the terminal state it
  // reaches when they run out, and is the state that mints the dead-letter copy.
  // The old sentence counted `failed` and called it "failing but still retrying
  // … these have attempts left", which is exactly backwards, and on a box in the
  // middle of a mass failure it reassured about the very jobs that had died.
  if (retry > 0) {
    verdicts.push({
      id: 'retrying',
      tone: 'warning',
      headline: `${retry.toLocaleString()} ${retry === 1 ? 'job is' : 'jobs are'} retrying.`,
      detail: 'These still have attempts left. They become dead letters if they run out.',
      filter: { state: 'retry', offset: 0 },
      action: 'Show',
    });
  }

  if (failed > 0) {
    verdicts.push({
      id: 'failed',
      tone: 'warning',
      headline: `${failed.toLocaleString()} ${failed === 1 ? 'job has' : 'jobs have'} failed outright.`,
      detail: 'Retries are spent. Each of these has a dead-letter copy holding its payload.',
      filter: { state: 'failed', offset: 0 },
      action: 'Show',
      clearScope: 'failed',
    });
  }

  // ── Taxonomy drift ──────────────────────────────────────────────────────
  // Not an outage — a gap in the dashboard's own vocabulary. Worth saying
  // because it silently shrinks every category number above it.
  if (unclassified > 0) {
    verdicts.push({
      id: 'unclassified',
      tone: 'warning',
      headline: `${unclassified.toLocaleString()} ${unclassified === 1 ? 'job has' : 'jobs have'} no taxonomy entry.`,
      detail:
        'They are counted but cannot be grouped or named. Adding a descriptor in domains/events/taxonomy.ts fixes it.',
      filter: { category: 'unclassified', type: '', offset: 0 },
      action: 'Show',
    });
  }

  // ── Schedules that fire and never succeed ───────────────────────────────
  // `running` on a schedule is not health, and "last run" is not "last
  // success" — a schedule failing every tick looks identical to a healthy one
  // on a list that only shows the former.
  const neverSucceeded = crons.filter((cron) => cron.lastRunAt != null && cron.lastSuccessAt == null);

  if (neverSucceeded.length > 0) {
    verdicts.push({
      id: 'never-succeeded',
      tone: 'critical',
      headline: `${neverSucceeded.length} ${neverSucceeded.length === 1 ? 'schedule has' : 'schedules have'} run and never succeeded.`,
      detail: neverSucceeded
        .slice(0, 3)
        .map((cron) => cron.name)
        .join(', '),
      filter: null,
      action: 'View schedules',
    });
  }

  const overdue = crons.filter((cron) => cron.overdue);

  if (overdue.length > 0) {
    verdicts.push({
      id: 'overdue',
      tone: 'warning',
      headline: `${overdue.length} ${overdue.length === 1 ? 'schedule is' : 'schedules are'} overdue.`,
      detail: overdue
        .slice(0, 3)
        .map((cron) => cron.name)
        .join(', '),
      filter: null,
      action: 'View schedules',
    });
  }

  // ── The all-clear ───────────────────────────────────────────────────────
  // Only when there is genuinely nothing to say, and only ever last. An
  // all-clear next to a critical verdict is noise; on its own it is the answer.
  if (verdicts.length === 0) {
    verdicts.push({
      id: 'healthy',
      tone: 'ok',
      headline: 'Nothing is stuck.',
      detail: `${active.toLocaleString()} running, nothing waiting, nothing failed.`,
      filter: null,
    });
  }

  // Critical first, then warnings — an operator reads top-down and should not
  // have to scan for the worst thing.
  const rank: Record<VerdictTone, number> = { critical: 0, warning: 1, ok: 2 };

  return verdicts.sort((a, b) => rank[a.tone] - rank[b.tone]);
}
