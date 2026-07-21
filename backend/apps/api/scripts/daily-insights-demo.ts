import 'reflect-metadata';

import { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import {
  DailyMetricEntity,
  DailyMetricsService,
  DescriptiveQuestionService,
  METRIC_KEYS,
  OllamaNarrator,
  TemplateNarrator,
  type DailyMetrics,
  type Narrator,
  type TextGenerator,
} from '@ci/domains/insights';

// =====================================================================
// daily-insights-demo — Daily Feature Store + compute-then-narrate CLI
// =====================================================================
// Computes a window of ci_derived.daily_metrics for one user, prints the
// anchor day's metric surface (with coverage), then answers the descriptive
// question catalog via compute-then-narrate.
//
//   yarn workspace @ci/be-api exec scripts/daily-insights-demo.ts \
//     --user <uuid> [--date YYYY-MM-DD] [--tz America/New_York] \
//     [--window 30] [--ollama]
//
// Requires a reachable database (it reads ci.* and writes ci_derived.*).
// --ollama opts into an OllamaNarrator for phrasing; it transparently falls
// back to the deterministic template if Ollama is unreachable.

interface Args {
  user: string;
  date: string;
  tz: string;
  window: number;
  ollama: boolean;
}

function todayIsoUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs(argv: string[]): Args {
  let user = '';
  let date = todayIsoUtc();
  let tz = 'UTC';
  let window = 30;
  let ollama = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--user') {
      user = argv[++i] ?? '';
    } else if (arg === '--date') {
      date = argv[++i] ?? date;
    } else if (arg === '--tz') {
      tz = argv[++i] ?? tz;
    } else if (arg === '--window') {
      window = Number.parseInt(argv[++i] ?? '30', 10);
    } else if (arg === '--ollama') {
      ollama = true;
    } else if (arg.startsWith('--user=')) {
      user = arg.slice('--user='.length);
    } else if (arg.startsWith('--date=')) {
      date = arg.slice('--date='.length);
    } else if (arg.startsWith('--tz=')) {
      tz = arg.slice('--tz='.length);
    } else if (arg.startsWith('--window=')) {
      window = Number.parseInt(arg.slice('--window='.length), 10);
    }
  }

  if (!user) {
    throw new Error(
      'Usage: daily-insights-demo.ts --user <uuid> [--date YYYY-MM-DD] [--tz <tz>] [--window <n>] [--ollama]',
    );
  }

  if (!Number.isInteger(window) || window < 1) {
    throw new Error(`--window must be a positive integer, got "${window}"`);
  }

  return { user, date, tz, window, ollama };
}

async function withDataSource<T>(fn: (db: DataSource) => Promise<T>): Promise<T> {
  const db = new DataSource({
    type: config.db.type,
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    username: config.db.username,
    password: config.db.password,
    entities: [DailyMetricEntity],
    synchronize: false,
    logging: ['error'],
    extra: { options: '-c search_path=ci,public' },
  });

  await db.initialize();
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
}

/** A fetch-backed TextGenerator so a real Ollama can phrase answers. */
function makeOllamaGenerator(): TextGenerator {
  const host = config.services.ollama.host;

  return {
    async generate(prompt: string): Promise<string> {
      const res = await fetch(`${host}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gemma3:1b', prompt, stream: false }),
      });
      if (!res.ok) {
        throw new Error(`ollama ${res.status}`);
      }

      const data = (await res.json()) as { response?: string };

      return data.response ?? '';
    },
  };
}

function printMetrics(day: DailyMetrics): void {
  console.log(`\nDaily Feature Store — ${day.date} (${day.timezone})`);
  console.log('  metric               value        coverage');
  console.log('  -------------------- ------------ --------');
  for (const key of METRIC_KEYS) {
    const value = day.metrics[key];
    const cov = day.coverage[key] ?? 0;
    const valueStr = value === null ? 'null (no data)' : String(value);
    console.log(`  ${key.padEnd(20)} ${valueStr.padEnd(12)} ${(cov * 100).toFixed(0)}%`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const context: UserServiceContext = { userId: args.user };
  const logger = new LoggerService();

  await withDataSource(async (db) => {
    const repo = db.getRepository(DailyMetricEntity);
    const metricsService = new DailyMetricsService(repo, logger);

    console.log(`Computing ${args.window} day(s) of metrics ending ${args.date} for ${args.user}...`);
    const window = await metricsService.computeWindow(context, args.date, args.window, args.tz);
    const anchor = window[window.length - 1];
    printMetrics(anchor);

    const narrator: Narrator = args.ollama
      ? new OllamaNarrator(makeOllamaGenerator())
      : new TemplateNarrator();
    const qa = new DescriptiveQuestionService(metricsService, narrator);

    console.log('\nDescriptive answers (compute-then-narrate):');
    const answers = await qa.answerAll(context, { date: args.date });
    for (const a of answers) {
      console.log(`\n  [${a.category}] ${a.question}`);
      console.log(`    ${a.answer}`);
      const p = a.provenance;
      console.log(
        `    provenance: metric=${p.metric} agg=${p.aggregate} days=${p.daysWithData}/${p.daysInRange} ` +
          `coverage=${(p.meanCoverage * 100).toFixed(0)}% sources=[${p.sources.join(', ')}]`,
      );
    }
  });
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(`\nFailed: ${(err as Error).message}`);
    process.exit(1);
  });
