import { CliError, type CliContext } from '../context';
import type {
  DueItemSummary,
  ForecastBucketSummary,
  PlaceForecastItemSummary,
  WeekForecastClusterSummary,
} from '../graphqlClient';
import { csv, json, stamp, table } from '../output';
import type {
  DecisionEngineKind,
  DecisionType,
  ModelRoutingPlanRequest,
  ModelRoutingTierInfo,
  RankCandidateInput,
  RankedCandidateSummary,
} from '../wire';

export interface InferenceTiersOptions {
  plan?: boolean;
  inputTokens?: string;
  outputTokens?: string;
  reasoning?: string;
  sensitive?: boolean;
  streaming?: boolean;
  preferOnDevice?: boolean;
  toolDepth?: string;
  json?: boolean;
}

export interface InferenceDecideOptions {
  type?: string;
  state?: string;
  action?: string;
  candidates?: string;
  criteria?: string;
  engine?: string;
  json?: boolean;
}

export interface InferenceRankOptions {
  query?: string;
  candidate?: string[];
  candidates?: string;
  topK?: string;
  engine?: string;
  json?: boolean;
}

export interface InferenceForecastOptions {
  horizon?: string;
  week?: boolean;
  includeToday?: boolean;
  due?: boolean;
  places?: boolean;
  limit?: string;
  horizonHours?: string;
  json?: boolean;
}

const VALID_REASONING = new Set(['light', 'moderate', 'deep']);
const VALID_DECISION_TYPES = new Set<DecisionType>(['noul', 'choice', 'score']);
const VALID_ENGINES = new Set<DecisionEngineKind>(['auto', 'contrastive', 'generative', 'hybrid']);

/**
 * Inspect model routing tiers and System 1 ActionVectorArena status, or simulate
 * a routing plan when `--plan` (or workload parameters) are provided.
 */
export async function inferenceTiersCommand(
  ctx: CliContext,
  options: InferenceTiersOptions = {},
): Promise<void> {
  const wantsPlan =
    Boolean(options.plan) ||
    options.inputTokens !== undefined ||
    options.outputTokens !== undefined ||
    options.reasoning !== undefined ||
    Boolean(options.sensitive) ||
    Boolean(options.streaming) ||
    Boolean(options.preferOnDevice) ||
    options.toolDepth !== undefined;

  if (wantsPlan) {
    const planReq = buildPlanRequest(options);
    const plan = await ctx.client.planModelRouting(planReq);

    if (options.json) {
      json(ctx.term, plan);

      return;
    }

    ctx.term.out(`tier        ${plan.tier}`);
    ctx.term.out(`provider    ${plan.provider}`);
    ctx.term.out(`model       ${plan.model}`);
    ctx.term.out(`latency     ~${plan.estimatedLatencyMs}ms`);
    ctx.term.out(`reason      ${plan.reason}`);
    if (plan.fallback) {
      ctx.term.out(`fallback    ${plan.fallback.tier} (${plan.fallback.provider}/${plan.fallback.model})`);
    }

    return;
  }

  const info = await ctx.client.getModelRoutingTiers();

  if (options.json) {
    json(ctx.term, info);

    return;
  }

  ctx.term.out(
    table<ModelRoutingTierInfo>(info.tiers, [
      { header: 'TIER', value: (t) => t.tier },
      { header: 'LATENCY', value: (t) => t.latency },
      { header: 'COST', value: (t) => t.cost },
      { header: 'PRIVACY', value: (t) => t.privacy },
      {
        header: 'DEFAULT MODELS',
        value: (t) =>
          Object.entries(t.defaultModels)
            .map(([k, v]) => `${k}=${v}`)
            .join(', '),
      },
    ]),
  );

  ctx.term.out('');
  const categories = Object.entries(info.arena.byCategory)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');

  ctx.term.out(
    `arena       ${info.arena.size} vectors (${info.arena.dimension}d)` +
      `${info.arena.builtAt ? ` built ${stamp(info.arena.builtAt)}` : ''}` +
      `${categories ? ` [${categories}]` : ''}`,
  );
}

/**
 * Run a Dual-Engine decision (`noul`, `choice`, or `score`) across System 1
 * (`contrastive`), System 2 (`generative`), or `hybrid`/`auto`.
 */
export async function inferenceDecideCommand(
  ctx: CliContext,
  options: InferenceDecideOptions,
): Promise<void> {
  const type = (options.type ?? 'noul').trim() as DecisionType;

  if (!VALID_DECISION_TYPES.has(type)) {
    throw new CliError('--type must be noul, choice, or score.');
  }

  const engine = (options.engine ?? 'auto').trim() as DecisionEngineKind;

  if (!VALID_ENGINES.has(engine)) {
    throw new CliError('--engine must be auto, contrastive, generative, or hybrid.');
  }

  const state = options.state?.trim();

  if (!state) {
    throw new CliError('--state is required.');
  }

  let candidates: string[] | undefined;

  if (type === 'noul' && !options.action?.trim()) {
    throw new CliError('--action is required when --type is noul.');
  }

  if (type === 'choice') {
    candidates = csv(options.candidates);
    if (!candidates || candidates.length < 2) {
      throw new CliError('--candidates must provide at least 2 comma-separated choices when --type is choice.');
    }
  }

  if (type === 'score' && !options.criteria?.trim()) {
    throw new CliError('--criteria is required when --type is score.');
  }

  const result = await ctx.client.decideModelRouting({
    type,
    state,
    ...(options.action ? { action: options.action.trim() } : {}),
    ...(candidates ? { candidates } : {}),
    ...(options.criteria ? { criteria: options.criteria.trim() } : {}),
    engine,
  });

  if (options.json) {
    json(ctx.term, result);

    return;
  }

  ctx.term.out(`type        ${result.type}`);
  ctx.term.out(`engine      ${result.engine} (${result.tier})`);
  ctx.term.out(`confidence  ${(result.confidence * 100).toFixed(1)}%`);
  ctx.term.out(`latency     ${result.latencyMs}ms`);

  if (result.noul !== undefined) {
    ctx.term.out(`noul        ${result.noul ? 'true (abstain / do not act)' : 'false (proceed)'}`);
  }

  if (result.selectedIndex !== undefined) {
    const label = candidates?.[result.selectedIndex];

    ctx.term.out(`selected    [${result.selectedIndex}]${label ? ` ${label}` : ''}`);
  }

  if (result.score !== undefined) {
    ctx.term.out(`score       ${result.score.toFixed(4)}`);
  }

  if (result.contrastiveScore !== undefined) {
    ctx.term.out(`system1     ${result.contrastiveScore.toFixed(4)}`);
  }

  if (result.generativeScore !== undefined) {
    ctx.term.out(`system2     ${result.generativeScore.toFixed(4)}`);
  }

  if (result.reasoning) {
    ctx.term.out(`reasoning   ${result.reasoning}`);
  }
}

/**
 * Rank candidate actions/items against a query using System 1 / System 2.
 */
export async function inferenceRankCommand(
  ctx: CliContext,
  options: InferenceRankOptions,
): Promise<void> {
  const query = options.query?.trim();

  if (!query) {
    throw new CliError('--query is required.');
  }

  const engine = (options.engine ?? 'auto').trim() as DecisionEngineKind;

  if (!VALID_ENGINES.has(engine)) {
    throw new CliError('--engine must be auto, contrastive, generative, or hybrid.');
  }

  const rawList = [...(options.candidate ?? []), ...(csv(options.candidates) ?? [])];

  if (rawList.length === 0) {
    throw new CliError('Pass at least one candidate via --candidate <id:text> or --candidates <c1,c2,...>.');
  }

  const candidates: RankCandidateInput[] = rawList.map((entry, idx) => {
    const colon = entry.indexOf(':');

    if (colon > 0) {
      return {
        id: entry.slice(0, colon).trim(),
        text: entry.slice(colon + 1).trim(),
      };
    }

    return { id: `c${idx + 1}`, text: entry.trim() };
  });

  const topK = parseOptionalPositiveInt(options.topK, '--top-k');
  const result = await ctx.client.rankModelRouting({
    query,
    candidates,
    ...(topK !== undefined ? { topK } : {}),
    engine,
  });

  if (options.json) {
    json(ctx.term, result);

    return;
  }

  ctx.term.out(`engine   ${result.engine} (${result.latencyMs}ms)`);
  ctx.term.out('');
  ctx.term.out(
    table<RankedCandidateSummary & { rank: number }>(
      result.ranked.map((item, idx) => ({ ...item, rank: idx + 1 })),
      [
        { header: 'RANK', align: 'right', value: (r) => String(r.rank) },
        { header: 'ID', value: (r) => r.id },
        { header: 'SCORE', align: 'right', value: (r) => r.score.toFixed(4) },
        { header: 'SOURCE', value: (r) => r.source },
        { header: 'TEXT', value: (r) => r.text },
      ],
    ),
  );
}

/**
 * Query HBPE behavioral forecasts (`forecast`, `weekForecast`, `dueForecast`, or `placeForecast`).
 */
export async function inferenceForecastCommand(
  ctx: CliContext,
  options: InferenceForecastOptions = {},
): Promise<void> {
  if (options.places) {
    const k = parseOptionalPositiveInt(options.limit, '--limit') ?? 5;
    const horizonHours = parseOptionalPositiveInt(options.horizonHours, '--horizon-hours') ?? 4;
    const places = await ctx.graphql.placeForecast(k, horizonHours);

    if (options.json) {
      json(ctx.term, places);

      return;
    }

    ctx.term.out(
      table<PlaceForecastItemSummary>(
        places,
        [
          { header: 'LABEL', value: (p) => p.label ?? p.clusterId ?? '(unlabeled)' },
          { header: 'PROB', align: 'right', value: (p) => `${(p.probability * 100).toFixed(1)}%` },
          { header: 'SHARE', align: 'right', value: (p) => `${(p.share * 100).toFixed(1)}%` },
          { header: 'VISITS', align: 'right', value: (p) => String(p.visits) },
          { header: 'COORDS', value: (p) => `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}` },
          { header: 'BACKOFF', value: (p) => p.backoffLevel ?? '-' },
        ],
        '(no place predictions available)',
      ),
    );

    return;
  }

  if (options.due) {
    const due = await ctx.graphql.dueForecast();

    if (!due) {
      throw new CliError('HBPE due forecast is unavailable on this appliance.');
    }

    if (options.json) {
      json(ctx.term, due);

      return;
    }

    ctx.term.out(`generated  ${stamp(due.generatedAt)}`);
    ctx.term.out(
      table<DueItemSummary>(
        due.due,
        [
          { header: 'BEHAVIOR', value: (d) => d.name },
          { header: 'CLASS', value: (d) => d.l0Class },
          { header: 'LAST SEEN', value: (d) => d.lastSeen.slice(0, 10) },
          { header: 'DAYS AGO', align: 'right', value: (d) => String(d.daysSinceLast) },
          { header: 'MEDIAN INT', align: 'right', value: (d) => `${d.medianIntervalDays.toFixed(1)}d` },
          { header: 'DUE IN', align: 'right', value: (d) => `${d.dueInDays.toFixed(1)}d` },
          { header: 'STATUS', value: (d) => (d.overdue ? 'OVERDUE' : 'upcoming') },
          { header: 'CONF', align: 'right', value: (d) => `${(d.confidence * 100).toFixed(0)}%` },
        ],
        '(no periodic behaviors due)',
      ),
    );

    return;
  }

  if (options.week) {
    const week = await ctx.graphql.weekForecast(Boolean(options.includeToday));

    if (!week) {
      throw new CliError('HBPE week forecast is unavailable on this appliance.');
    }

    if (options.json) {
      json(ctx.term, week);

      return;
    }

    ctx.term.out(`horizon    ${week.horizon}  (generated ${stamp(week.generatedAt)})`);
    const rows: Array<WeekForecastClusterSummary & { date: string; dow: string }> = [];

    for (const day of week.days) {
      for (const cluster of day.clusters) {
        rows.push({ ...cluster, date: day.date, dow: day.dow });
      }
    }

    ctx.term.out(
      table(
        rows,
        [
          { header: 'DATE', value: (r) => `${r.date} (${r.dow.slice(0, 3)})` },
          { header: 'CLUSTER', value: (r) => r.name },
          { header: 'CLASS', value: (r) => r.l0Class },
          { header: 'P(OCCUR)', align: 'right', value: (r) => `${(r.pOccur * 100).toFixed(1)}%` },
          { header: 'SOURCE', value: (r) => (r.scheduled ? 'calendar' : 'hbpe') },
        ],
        '(no week forecast clusters)',
      ),
    );

    return;
  }

  const horizon = options.horizon?.trim() || '24h';
  const forecast = await ctx.graphql.forecast(horizon);

  if (!forecast) {
    throw new CliError('HBPE forecast is unavailable on this appliance.');
  }

  if (options.json) {
    json(ctx.term, forecast);

    return;
  }

  ctx.term.out(
    `status     ${forecast.systemStatus}  model=${forecast.modelVersion ?? 'baseline'}  ` +
      `horizon=${forecast.horizon}  generated=${stamp(forecast.generatedAt)}`,
  );

  const limit = parseOptionalPositiveInt(options.limit, '--limit') ?? 12;
  const displayed = forecast.buckets.slice(0, limit);

  ctx.term.out(
    table<ForecastBucketSummary>(
      displayed,
      [
        { header: 'BUCKET', align: 'right', value: (b) => String(b.bucketIndex) },
        { header: 'START TIME', value: (b) => stamp(b.startTime) },
        { header: 'PREDICTED L0', value: (b) => b.predictedL0 ?? '-' },
        {
          header: 'TOP L1',
          value: (b) => {
            const top = b.l1Probs[0];

            return top ? `${top.label} (${(top.probability * 100).toFixed(0)}%)` : '-';
          },
        },
        { header: 'Q50', align: 'right', value: (b) => b.q50.toFixed(2) },
      ],
      '(no forecast buckets)',
    ),
  );
}

function buildPlanRequest(options: InferenceTiersOptions): ModelRoutingPlanRequest {
  const inputTokens = parseOptionalPositiveInt(options.inputTokens, '--input-tokens');
  const outputTokens = parseOptionalPositiveInt(options.outputTokens, '--output-tokens');
  const toolDepth = parseOptionalPositiveInt(options.toolDepth, '--tool-depth');

  let reasoningDepth: 'light' | 'moderate' | 'deep' | undefined;

  if (options.reasoning !== undefined) {
    const r = options.reasoning.trim();

    if (!VALID_REASONING.has(r)) {
      throw new CliError('--reasoning must be light, moderate, or deep.');
    }

    reasoningDepth = r as 'light' | 'moderate' | 'deep';
  }

  return {
    ...(inputTokens !== undefined ? { estimatedInputTokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { estimatedOutputTokens: outputTokens } : {}),
    ...(reasoningDepth !== undefined ? { reasoningDepth } : {}),
    ...(options.sensitive ? { requiresSensitiveData: true } : {}),
    ...(options.streaming ? { requiresStreaming: true } : {}),
    ...(options.preferOnDevice ? { preferOnDevice: true } : {}),
    ...(toolDepth !== undefined ? { toolCallDepth: toolDepth } : {}),
  };
}

function parseOptionalPositiveInt(raw: string | undefined, flagName: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const parsed = /^\s*\d+\s*$/.test(raw) ? Number(raw) : Number.NaN;

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliError(`${flagName} must be a positive integer.`);
  }

  return parsed;
}
