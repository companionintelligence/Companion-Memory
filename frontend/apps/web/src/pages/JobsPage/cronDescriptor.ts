import { categoryLabel } from './jobCategories';
import type { JobTypesResponse } from './useJobTypes';

/**
 * What a recurring job actually is, derived from how it registered.
 *
 * Crons register as `ClassName.methodName`, which is precise but not a name a
 * person reads. The Jobs table gets its labels from the taxonomy, keyed by EVENT
 * name — but most crons don't emit an event of their own, so almost none of them
 * hit it. Falling back to the bare method name produced eight schedules all
 * called "Run", and lumping the lot under one category made the column useless.
 *
 * So: prefer the taxonomy when the cron's key IS a known event, otherwise derive
 * from the class. The class is the honest source — it says which subsystem
 * registered the job — and it's already right there in the key.
 */

/** Class-name prefix → category. First match wins, so order matters. */
const CLASS_CATEGORY: ReadonlyArray<readonly [RegExp, string]> = [
  [/^SmartRotation/, 'personalization'],
  [/^Pipeline/, 'pipeline'],
  [/^PythonFunction/, 'llm'],
  [/^AnswerInference/, 'llm'],
  [/^PlanningJobs/, 'planning'],
  [/Sync(Orchestrator|Cron)/, 'import'],
  [/^ImportStage/, 'import'],
  [/^EntityPromotion/, 'graph'],
  [/^(DailyMetrics|ActivityRollup|JobMetrics)/, 'maintenance'],
  [
    /^(DeadLetterReaper|MemoryCompaction|FeedQueue|InitialActions|StagedUploadPurge|AccountPurge)/,
    'maintenance',
  ],
  [/^Mcp/, 'maintenance'],
];

/**
 * Method names too generic to identify a job on their own — for these the class
 * carries the meaning, so the label is built from the class instead.
 */
const GENERIC_METHODS = new Set(['run', 'tick', 'execute', 'handle', 'process', 'cron']);

/** `sampleOnSchedule` is a decorator wrapper; `sample` is the work it names. */
const SCHEDULE_WRAPPER = /onSchedule$/i;

const CLASS_SUFFIX = /(Cron|Service|Listener|Controller|Collector)s?$/;

/** What `@nestjs/schedule` mints when a `@Cron` ships without a `name`. */
const MINTED_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CronDescriptor {
  readonly label: string;
  readonly category: string;
  readonly categoryLabel: string;
  /**
   * The scheduler named this job itself, because its `@Cron` has no `name`. The
   * key is re-minted every boot, so nothing durable — the `ci.cron_runs` history,
   * the last-run cell, the manual-run button — can ever find it again. Always a
   * backend bug, so the UI shows it as one rather than rendering the UUID and
   * moving on.
   */
  readonly unnamed: boolean;
}

export function describeCron(name: string, jobTypes: JobTypesResponse | null): CronDescriptor {
  // 1. The cron key IS a known event — use exactly what the Jobs table shows.
  const fromTaxonomy = jobTypes?.types?.[name];
  if (fromTaxonomy) {
    return {
      label: fromTaxonomy.label,
      category: fromTaxonomy.category,
      categoryLabel: categoryLabel(fromTaxonomy.category),
      unnamed: false,
    };
  }

  // 2. A minted key names nothing and belongs nowhere; guessing a category from
  //    it would only make the row look as settled as the other forty.
  if (MINTED_KEY.test(name)) {
    return {
      label: name,
      category: 'unclassified',
      categoryLabel: categoryLabel('unclassified'),
      unnamed: true,
    };
  }

  const [cls, method] = splitKey(name);
  const category = CLASS_CATEGORY.find(([pattern]) => pattern.test(cls))?.[1] ?? 'maintenance';

  return {
    label: buildLabel(cls, method),
    category,
    categoryLabel: categoryLabel(category),
    unnamed: false,
  };
}

function splitKey(name: string): [string, string] {
  const dot = name.lastIndexOf('.');

  return dot === -1 ? [name, ''] : [name.slice(0, dot), name.slice(dot + 1)];
}

/**
 * `SmartRotationInsightsCron.run`        → "Smart rotation insights".
 * `FeedQueueCron.topUpFeedQueue`         → "Top up feed queue".
 * `JobMetricsCollector.purgeOnSchedule`  → "Job metrics purge".
 *
 * The method wins when it says something; the class wins when the method is
 * generic. `Cron`/`Service`/`Listener` suffixes are dropped — every row would
 * otherwise end in the same noise word.
 *
 * A `*OnSchedule` method is a decorator wrapper around work the class already
 * names, so it is labelled from the class and keeps only the verb that tells two
 * schedules on one class apart — "Job metrics sample" beside "Job metrics
 * purge", not "Job metrics" beside "Purge on schedule".
 */
function buildLabel(cls: string, method: string): string {
  const subject = sentenceCase(cls.replace(CLASS_SUFFIX, ''));
  const verb = method.replace(SCHEDULE_WRAPPER, '');

  if (!verb || GENERIC_METHODS.has(verb.toLowerCase())) {
    return subject;
  }

  if (verb === method) {
    return sentenceCase(method);
  }

  const words = sentenceCase(verb).toLowerCase();

  return subject.toLowerCase().includes(words) ? subject : `${subject} ${words}`;
}

function sentenceCase(identifier: string): string {
  const words = identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();

  return words.charAt(0).toUpperCase() + words.slice(1);
}
