/**
 * Forecast-side reading of CI Forager's discrete saccades, mapped onto HBPE
 * buckets we already have. This is not the Python forager (ci_forage.trial);
 * it is the same two-slider picture: branch mass, then texture given branch.
 *
 * Forager (ci_forage/trial.py):
 *   slider 1  Q(branch)           — beach / office / errands
 *   slider 2  Q(texture | branch) — who you meet under that branch
 *   gaze      unread lake item scored by expected free energy G
 *   commit    mass ≥ 0.6 before a pick is "ready"
 *
 * HBPE histogram:
 *   slider 1  L0 class for a 30-min bucket
 *   slider 2  L1 under that same bucket (not people — we do not have that factor)
 *   gaze      analog: a history day's same half-hour, ranked by KL vs tomorrow
 *
 * Occupancy is equal-weight by construction. Serializer writes one L0 token per
 * labeled event with soft_prob [1.0]. Baselines add +1 per token. Event duration
 * and source type never enter the count. Kernel weights history *days*, not labels.
 */

import type { ForecastBucket, ProbabilityEntry } from '@/api/useForecastService';

/** Same threshold as ci_forage.trial.COMMIT_MASS. */
export const COMMIT_MASS = 0.6;

const EPS = 1e-12;

export type MassRow = { label: string; mass: number };

export type HistoryDayLike = {
  date: string;
  buckets: Array<{
    bucketIndex: number;
    predictedL0: ProbabilityEntry[];
    actualL0?: string | null;
  }>;
};

export type BranchPick = {
  bucketIndex: number;
  startTime: string;
  branches: MassRow[];
  permutations: MassRow[];
  entropy: number;
  ready: boolean;
  branch: string | null;
  texture: string | null;
  textureMass: number | null;
};

export type SaccadeRow = {
  date: string;
  kl: number;
  observed: string | null;
  predicted: string | null;
};

export function normalizeMass(entries: ProbabilityEntry[]): MassRow[] {
  const rows = entries
    .map((entry) => ({ label: entry.label, mass: Math.max(0, entry.probability) }))
    .filter((row) => row.label.length > 0);
  const total = rows.reduce((sum, row) => sum + row.mass, 0);
  if (total <= 0) {
    return [];
  }

  return rows.map((row) => ({ ...row, mass: row.mass / total })).sort((a, b) => b.mass - a.mass);
}

export function entropy(mass: MassRow[]): number {
  return -mass.reduce((sum, row) => {
    if (row.mass <= 0) {
      return sum;
    }

    return sum + row.mass * Math.log(row.mass);
  }, 0);
}

export function klDivergence(p: MassRow[], q: MassRow[]): number {
  const qMap = new Map(q.map((row) => [row.label, Math.max(row.mass, EPS)]));
  let kl = 0;
  for (const row of p) {
    if (row.mass <= 0) {
      continue;
    }

    kl += row.mass * Math.log(row.mass / (qMap.get(row.label) ?? EPS));
  }

  return kl;
}

function oneHot(label: string): MassRow[] {
  return [{ label, mass: 1 }];
}

function topOf(mass: MassRow[]): MassRow | null {
  return mass[0] ?? null;
}

/**
 * Highest-entropy upcoming half-hour. That is the slot whose L0 is least
 * settled — the analog of Forager scoring gazes by how much they would shrink
 * uncertainty, except here we start from the forecast itself.
 */
export function pickOpenSlot(buckets: ForecastBucket[], nowMs = Date.now()): ForecastBucket | null {
  const upcoming = buckets.filter((bucket) => {
    const t = new Date(bucket.startTime).getTime();

    return Number.isFinite(t) && t >= nowMs && bucket.l0Probs.length > 0;
  });
  if (upcoming.length === 0) {
    return buckets.find((bucket) => bucket.l0Probs.length > 0) ?? null;
  }

  let best = upcoming[0];
  let bestH = -Infinity;
  for (const bucket of upcoming) {
    const h = entropy(normalizeMass(bucket.l0Probs));
    if (h > bestH) {
      bestH = h;
      best = bucket;
    }
  }

  return best;
}

export function branchPick(bucket: ForecastBucket): BranchPick {
  const branches = normalizeMass(bucket.l0Probs);
  const permutations = normalizeMass(bucket.l1Probs);
  const topBranch = topOf(branches);
  const ready = (topBranch?.mass ?? 0) >= COMMIT_MASS;
  const topTexture = topOf(permutations);
  const textureReady = ready && (topTexture?.mass ?? 0) >= COMMIT_MASS;

  return {
    bucketIndex: bucket.bucketIndex,
    startTime: bucket.startTime,
    branches,
    permutations,
    entropy: entropy(branches),
    ready,
    branch: ready ? (topBranch?.label ?? null) : null,
    texture: textureReady ? (topTexture?.label ?? null) : null,
    textureMass: textureReady ? (topTexture?.mass ?? null) : null,
  };
}

/**
 * Rank history days as discrete gazes: how much that day's same half-hour
 * disagrees with tomorrow's L0. High KL is high epistemic value — reading that
 * day would move the call. Observed actuals beat the day's own prediction when
 * the nightly backfill has them.
 */
export function rankSaccades(
  historyDays: HistoryDayLike[],
  bucketIndex: number,
  forecastL0: ProbabilityEntry[],
): SaccadeRow[] {
  const forecast = normalizeMass(forecastL0);
  if (forecast.length === 0) {
    return [];
  }

  const rows: SaccadeRow[] = [];
  for (const day of historyDays) {
    const slot = day.buckets.find((bucket) => bucket.bucketIndex === bucketIndex);
    if (!slot) {
      continue;
    }

    const observed = slot.actualL0 ?? null;
    const predicted = topOf(normalizeMass(slot.predictedL0))?.label ?? null;
    const reference = observed ? oneHot(observed) : normalizeMass(slot.predictedL0);
    if (reference.length === 0) {
      continue;
    }

    rows.push({
      date: day.date,
      kl: klDivergence(forecast, reference),
      observed,
      predicted,
    });
  }

  return rows.sort((a, b) => b.kl - a.kl);
}

export function formatSlotClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return `bucket ${iso}`;
  }

  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
