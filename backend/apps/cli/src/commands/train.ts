import { CliError, type CliContext } from '../context';
import type { CalibrationScoreSummary } from '../graphqlClient';
import { json, stamp, table } from '../output';

export interface TrainRunOptions {
  json?: boolean;
}

export interface TrainCalibrationOptions {
  limit?: string;
  json?: boolean;
}

export interface TrainRebuildPlacesOptions {
  json?: boolean;
}

/**
 * Trigger the HBPE training and behavioral pipeline (`triggerHbpe` mutation).
 *
 * Enqueues the `hbpe-scheduled` job for the authenticated user on `hbpe-service`,
 * which runs cold-start bootstrap training when no checkpoint exists or the
 * 6-step nightly pipeline (including `hbpe-lora-train` when scheduled).
 */
export async function trainRunCommand(ctx: CliContext, options: TrainRunOptions = {}): Promise<void> {
  const status = await ctx.graphql.triggerHbpe();

  if (options.json) {
    json(ctx.term, { status, ok: status === 'triggered' || status === 'already_running' });
  }

  if (status === 'disabled') {
    throw new CliError('HBPE training is disabled on this appliance (feature flag `hbpe` is off).');
  }

  if (status === 'error') {
    throw new CliError('Failed to enqueue HBPE training job on the appliance.');
  }

  if (!options.json) {
    if (status === 'already_running') {
      ctx.term.out('HBPE training pipeline is already queued or running for this account.');
    } else {
      ctx.term.out('HBPE training pipeline enqueued (`hbpe-scheduled` -> `hbpe-service`).');
    }
  }
}

/**
 * Inspect walk-forward HBPE prediction calibration and drift metrics.
 */
export async function trainCalibrationCommand(
  ctx: CliContext,
  options: TrainCalibrationOptions = {},
): Promise<void> {
  const limit = parseOptionalPositiveInt(options.limit, '--limit');
  const report = await ctx.graphql.predictionCalibration(limit);

  if (!report) {
    throw new CliError('HBPE calibration is unavailable (feature disabled or no calibration service).');
  }

  if (options.json) {
    json(ctx.term, report);

    return;
  }

  ctx.term.out(`basis   ${report.basis}`);

  if (!report.latest) {
    ctx.term.out('latest  (no scored predictions yet)');

    return;
  }

  const latest = report.latest;

  ctx.term.out(
    `latest  model=${latest.modelVersion ?? 'unknown'}  brier=${fmtNum(latest.brier)}  ece=${fmtNum(latest.ece)}  ` +
      `l0_top1=${fmtPct(latest.l0Top1Acc)}  l1_top3=${fmtPct(latest.l1Top3Acc)}  ` +
      `drift=${latest.driftFlag ? 'YES' : 'no'}`,
  );

  if (report.history.length > 0) {
    ctx.term.out('');
    ctx.term.out(
      table<CalibrationScoreSummary>(report.history, [
        { header: 'SCORED AT', value: (r) => stamp(r.scoredAt) },
        { header: 'MODEL', value: (r) => r.modelVersion ?? '-' },
        { header: 'BRIER', align: 'right', value: (r) => fmtNum(r.brier) },
        { header: 'ECE', align: 'right', value: (r) => fmtNum(r.ece) },
        { header: 'L0 TOP-1', align: 'right', value: (r) => fmtPct(r.l0Top1Acc) },
        { header: 'L1 TOP-3', align: 'right', value: (r) => fmtPct(r.l1Top3Acc) },
        { header: 'COVERAGE', align: 'right', value: (r) => fmtPct(r.coverage) },
        { header: 'BUCKETS', align: 'right', value: (r) => (r.nBuckets != null ? String(r.nBuckets) : '-') },
        { header: 'DRIFT', value: (r) => (r.driftFlag ? 'DRIFT' : 'ok') },
      ]),
    );
  }
}

/**
 * Rebuild stay-point clusters and recency-decayed Markov place transitions.
 */
export async function trainRebuildPlacesCommand(
  ctx: CliContext,
  options: TrainRebuildPlacesOptions = {},
): Promise<void> {
  const result = await ctx.graphql.rebuildPlaces();

  if (options.json) {
    json(ctx.term, { result, ok: result !== 'disabled' && result !== 'error' });
  }

  if (result === 'disabled') {
    throw new CliError('Place transition training is disabled on this appliance (feature flag `hbpe` is off).');
  }

  if (result === 'error') {
    throw new CliError('Failed to rebuild stay-point clusters and place transitions.');
  }

  if (!options.json) {
    ctx.term.out(`Rebuilt place transition model: ${result}.`);
  }
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

function fmtNum(val: number | null | undefined): string {
  return val == null ? '-' : val.toFixed(4);
}

function fmtPct(val: number | null | undefined): string {
  return val == null ? '-' : `${(val * 100).toFixed(1)}%`;
}
