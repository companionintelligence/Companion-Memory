import { CliError, type CliContext } from '../context';
import type {
  DueItemSummary,
  ForecastBucketSummary,
  PlaceForecastItemSummary,
  WeekForecastClusterSummary,
} from '../graphqlClient';
import { csv, json, stamp, table } from '../output';
import type {
  ChoiceCandidateScore,
  DecisionEngineMode,
  DecisionPrimitive,
  DecisionRequest,
  ModelTier,
  RankCandidateInput,
  RankedCandidate,
  ReasoningLevel,
  RoutingRequest,
  ScoreCriterion,
  ScoreCriterionResult,
  TierProfile,
} from '../wire';

export interface InferenceTiersOptions {
  plan?: boolean;
  inputTokens?: string;
  reasoning?: string;
  toolDepth?: string;
  largeContext?: boolean;
  /** The privacy pin. Sent as `localOnly`, the field the planner reads. */
  sensitive?: boolean;
  forceTier?: string;
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

const VALID_REASONING = new Set<ReasoningLevel>(['light', 'moderate', 'deep']);
const VALID_TIERS = new Set<ModelTier>(['on_device', 'private_cloud']);
const VALID_PRIMITIVES = new Set<DecisionPrimitive>(['noul', 'choice', 'score']);
const VALID_ENGINES = new Set<DecisionEngineMode>(['auto', 'contrastive', 'generative', 'hybrid']);

/**
 * Show the two routing tiers and the ActionVectorArena's size, or plan which
 * tier one task runs on when `--plan` (or any task characteristic) is given.
 */
export async function inferenceTiersCommand(
  ctx: CliContext,
  options: InferenceTiersOptions = {},
): Promise<void> {
  const wantsPlan =
    Boolean(options.plan) ||
    options.inputTokens !== undefined ||
    options.reasoning !== undefined ||
    options.toolDepth !== undefined ||
    Boolean(options.largeContext) ||
    Boolean(options.sensitive) ||
    options.forceTier !== undefined;

  if (wantsPlan) {
    const request = buildPlanRequest(options);
    const plan = await ctx.client.planModelRouting(request);

    if (options.json) {
      json(ctx.term, plan);

      return;
    }

    ctx.term.out(`tier        ${plan.tier} (${plan.profile.title})`);
    ctx.term.out(`reasoning   ${plan.reasoningLevel}`);
    ctx.term.out(`context     ${plan.profile.maxContextTokens.toLocaleString('en-US')} tokens`);
    ctx.term.out(`leaves box  ${plan.profile.external ? 'yes' : 'no'}`);

    if (plan.downgraded) {
      ctx.term.out('downgraded  yes: the task wanted the private-cloud tier and was kept on the appliance');
    }

    plan.reasons.forEach((reason, index) => {
      ctx.term.out(`${index === 0 ? 'why' : '   '}         ${reason}`);
    });

    return;
  }

  const [info, arena] = await Promise.all([
    ctx.client.getModelRoutingTiers(),
    ctx.client.getModelRoutingArena(),
  ]);

  if (options.json) {
    json(ctx.term, { ...info, arena });

    return;
  }

  ctx.term.out(
    table<TierProfile>(info.tiers, [
      { header: 'TIER', value: (t) => t.tier },
      { header: 'TITLE', value: (t) => t.title },
      { header: 'CONTEXT', align: 'right', value: (t) => t.maxContextTokens.toLocaleString('en-US') },
      { header: 'OFFLINE', value: (t) => (t.offline ? 'yes' : 'no') },
      { header: 'LEAVES BOX', value: (t) => (t.external ? 'yes' : 'no') },
    ]),
  );
  ctx.term.out('');
  ctx.term.out(`arena       ${arena.size} cached candidate vector${arena.size === 1 ? '' : 's'}`);
}

/**
 * Run one Dual-Engine decision primitive (`noul`, `choice`, or `score`) on
 * System 1 (`contrastive`), System 2 (`generative`), or `hybrid`/`auto`.
 */
export async function inferenceDecideCommand(
  ctx: CliContext,
  options: InferenceDecideOptions,
): Promise<void> {
  const primitive = (options.type ?? 'noul').trim() as DecisionPrimitive;

  if (!VALID_PRIMITIVES.has(primitive)) {
    throw new CliError('--type must be noul, choice, or score.');
  }

  const engine = parseEngine(options.engine);
  const state = options.state?.trim();

  if (!state) {
    throw new CliError('--state is required.');
  }

  const request = buildDecisionRequest(primitive, state, engine, options);
  const result = await ctx.client.decideModelRouting(request);

  if (options.json) {
    json(ctx.term, result);

    return;
  }

  ctx.term.out(`primitive   ${result.primitive}`);
  ctx.term.out(`engine      ${result.engineUsed}`);

  if (result.engineUsed === 'disabled') {
    ctx.term.out('            both engines are switched off in Settings: what follows is a neutral default');
  }

  switch (result.primitive) {
    case 'noul':
      ctx.term.out(
        `decision    ${result.decision ? 'yes: the action applies' : 'no: the action does not apply'}`,
      );
      ctx.term.out(`probability ${percent(result.probability)}`);
      ctx.term.out(`margin      ${result.margin.toFixed(4)}`);
      break;

    case 'choice':
      ctx.term.out(
        `selected    ${result.selectedId == null ? '(none)' : `[${result.selectedId}] ${result.selectedLabel ?? ''}`}`,
      );
      ctx.term.out(`confidence  ${percent(result.confidence)}`);
      ctx.term.out(`margin      ${result.margin.toFixed(4)}`);

      if (result.escalatedToGenerative) {
        ctx.term.out('escalated   yes: System 1 was not sure enough, so System 2 was asked too');
      }

      ctx.term.out('');
      ctx.term.out(
        table<ChoiceCandidateScore>(result.candidates, [
          { header: 'ID', value: (c) => c.id },
          { header: 'CANDIDATE', value: (c) => c.label },
          { header: 'PROB', align: 'right', value: (c) => percent(c.probability) },
          { header: 'SIMILARITY', align: 'right', value: (c) => c.similarity.toFixed(4) },
        ]),
      );
      break;

    case 'score':
      ctx.term.out(`score       ${percent(result.compositeScore)}`);
      ctx.term.out('');
      ctx.term.out(
        table<ScoreCriterionResult>(result.criteria, [
          { header: 'CRITERION', value: (c) => c.name },
          { header: 'PROB', align: 'right', value: (c) => percent(c.probability) },
          { header: 'WEIGHT', align: 'right', value: (c) => String(c.weight) },
        ]),
      );
      break;
  }

  ctx.term.out(`latency     ${result.latencyMs}ms`);
}

/**
 * Rank candidate actions/items against a query using System 1 / System 2.
 */
export async function inferenceRankCommand(ctx: CliContext, options: InferenceRankOptions): Promise<void> {
  const query = options.query?.trim();

  if (!query) {
    throw new CliError('--query is required.');
  }

  const engine = parseEngine(options.engine);
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

  ctx.term.out(
    `engine   ${result.engineUsed} (${result.latencyMs}ms; arena ${result.arenaHitCount} cached, ` +
      `${result.arenaMissCount} embedded)`,
  );
  ctx.term.out('');
  ctx.term.out(
    table<RankedCandidate>(
      result.items,
      [
        { header: 'RANK', align: 'right', value: (r) => String(r.rank) },
        { header: 'ID', value: (r) => r.id },
        { header: 'SCORE', align: 'right', value: (r) => r.score.toFixed(4) },
        { header: 'PROB', align: 'right', value: (r) => percent(r.probability) },
        { header: 'TEXT', value: (r) => r.text },
      ],
      '(nothing ranked)',
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

/**
 * Flags to the planner's request. Every field here is one
 * `routingRequestSchema` reads: that schema strips the rest, so a flag sent
 * under any other name does nothing and says nothing.
 */
function buildPlanRequest(options: InferenceTiersOptions): RoutingRequest {
  const estimatedInputTokens = parseOptionalPositiveInt(options.inputTokens, '--input-tokens');
  const toolDepth = parseOptionalPositiveInt(options.toolDepth, '--tool-depth');

  let reasoningLevel: ReasoningLevel | undefined;

  if (options.reasoning !== undefined) {
    const level = options.reasoning.trim() as ReasoningLevel;

    if (!VALID_REASONING.has(level)) {
      throw new CliError('--reasoning must be light, moderate, or deep.');
    }

    reasoningLevel = level;
  }

  let forceTier: ModelTier | undefined;

  if (options.forceTier !== undefined) {
    // `on-device` is how the tier is spoken; `on_device` is how the API spells it.
    const tier = options.forceTier.trim().replace(/-/g, '_') as ModelTier;

    if (!VALID_TIERS.has(tier)) {
      throw new CliError('--force-tier must be on_device or private_cloud.');
    }

    forceTier = tier;
  }

  return {
    ...(estimatedInputTokens !== undefined ? { estimatedInputTokens } : {}),
    ...(reasoningLevel !== undefined ? { reasoningLevel } : {}),
    ...(toolDepth !== undefined ? { toolDepth } : {}),
    ...(options.largeContext ? { requiresLargeContext: true } : {}),
    ...(options.sensitive ? { localOnly: true } : {}),
    ...(forceTier !== undefined ? { forceTier } : {}),
  };
}

/** The body `POST /model-routing/decide` takes for this primitive, with its own flag checked. */
function buildDecisionRequest(
  primitive: DecisionPrimitive,
  state: string,
  engine: DecisionEngineMode,
  options: InferenceDecideOptions,
): DecisionRequest {
  switch (primitive) {
    case 'noul': {
      const action = options.action?.trim();

      if (!action) {
        throw new CliError('--action is required when --type is noul.');
      }

      return { primitive, state, action, engine };
    }

    case 'choice': {
      const candidates = csv(options.candidates);

      if (!candidates || candidates.length < 2) {
        throw new CliError(
          '--candidates must provide at least 2 comma-separated choices when --type is choice.',
        );
      }

      return { primitive, state, candidates, engine };
    }

    case 'score':
      return { primitive, state, criteria: parseCriteria(options.criteria), engine };
  }
}

/**
 * `--criteria "urgent:needs doing today,social"` → one criterion per entry.
 *
 * The server scores a rubric, not a sentence: each criterion is a named
 * positive pole, scored as `noul(state, pole)` against `not <pole>`. An entry
 * without a `name:` is named after its pole, the same way `rank` reads
 * `--candidate id:text`.
 */
function parseCriteria(raw: string | undefined): ScoreCriterion[] {
  const entries = csv(raw);

  if (!entries) {
    throw new CliError(
      '--criteria is required when --type is score: comma-separated poles, each optionally name:pole.',
    );
  }

  return entries.map((entry) => {
    const colon = entry.indexOf(':');
    const name = colon > 0 ? entry.slice(0, colon).trim() : entry;
    const positive = colon > 0 ? entry.slice(colon + 1).trim() : entry;

    if (!positive) {
      throw new CliError(`--criteria entry "${entry}" names no pole to score.`);
    }

    return { name, positive };
  });
}

function parseEngine(raw: string | undefined): DecisionEngineMode {
  const engine = (raw ?? 'auto').trim() as DecisionEngineMode;

  if (!VALID_ENGINES.has(engine)) {
    throw new CliError('--engine must be auto, contrastive, generative, or hybrid.');
  }

  return engine;
}

function percent(probability: number): string {
  return `${(probability * 100).toFixed(1)}%`;
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
