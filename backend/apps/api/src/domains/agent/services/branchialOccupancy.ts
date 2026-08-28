/**
 * Occupancy spine for branchial time: competing futures along a horizontal
 * clock, before the LLM names them from memory.
 *
 * Columns are remaining dayparts of today (from the 24h histogram), plus any
 * booked calendar clusters for those dayparts. Week-ahead habits stay on
 * Week Ahead — they are not occupancy branches.
 */

import type { ForecastBucket, WeekForecastCluster, WeekForecastResponse } from '@ci/domains/predictions';

import {
  MIN_BRANCH_MASS,
  clusterPasses,
  displayNameFor,
  isDisplayableLabel,
  isUnknownClass,
  occupancyLabelOk,
} from './forecastQuality';

export const DAYPARTS = [
  { id: 'night', label: 'Night', startHour: 0, endHour: 6 },
  { id: 'morning', label: 'Morning', startHour: 6, endHour: 12 },
  { id: 'afternoon', label: 'Afternoon', startHour: 12, endHour: 18 },
  { id: 'evening', label: 'Evening', startHour: 18, endHour: 24 },
] as const;

const TOP_K = 3;

export type BranchialPermutation = {
  id: string;
  title: string;
  mass: number;
};

export type BranchialBranch = {
  id: string;
  title: string;
  l0: string;
  mass: number;
  why: string;
  permutations: BranchialPermutation[];
};

export type BranchialStep = {
  id: string;
  label: string;
  startTime: string;
  branches: BranchialBranch[];
};

export type BranchialTree = {
  question: string;
  guessed: boolean;
  steps: BranchialStep[];
};

export function emptyOccupancyTree(): BranchialTree {
  return {
    question: 'What happens next',
    guessed: false,
    steps: [],
  };
}

export function hourInZone(iso: string, timeZone: string): number {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return 0;
  }

  const hourPart = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(date)
    .find((part) => part.type === 'hour')?.value;

  return Number.parseInt(hourPart ?? '0', 10) || 0;
}

function topMasses(probs: Record<string, number>, k = TOP_K): Array<{ label: string; mass: number }> {
  return Object.entries(probs)
    .map(([label, mass]) => ({ label, mass: Number(mass) || 0 }))
    .filter((row) => occupancyLabelOk(row.label, row.mass))
    .sort((a, b) => b.mass - a.mass)
    .slice(0, k);
}

function averageMaps(maps: Array<Record<string, number>>): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const map of maps) {
    for (const [key, value] of Object.entries(map)) {
      sums[key] = (sums[key] ?? 0) + (Number(value) || 0);
    }
  }

  const n = Math.max(maps.length, 1);

  return Object.fromEntries(Object.entries(sums).map(([key, value]) => [key, value / n]));
}

function permutationsFrom(probs: Record<string, number>): BranchialPermutation[] {
  return topMasses(probs).map((row) => ({
    id: row.label,
    title: row.label,
    mass: row.mass,
  }));
}

function partById(id: string): (typeof DAYPARTS)[number] | undefined {
  return DAYPARTS.find((part) => part.id === id);
}

function remainingParts(now: Date, timeZone: string): Array<(typeof DAYPARTS)[number]> {
  const hour = hourInZone(now.toISOString(), timeZone);

  return DAYPARTS.filter((part) => hour < part.endHour);
}

function topDaypart(probs: Record<string, number>): (typeof DAYPARTS)[number] | undefined {
  const ranked = Object.entries(probs).sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0));
  const id = ranked[0]?.[0];

  return id ? partById(id) : undefined;
}

function sortSteps(steps: BranchialStep[]): BranchialStep[] {
  const order = new Map<string, number>(DAYPARTS.map((part, index) => [part.id, index]));

  return [...steps].sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
}

function capBranches(branches: BranchialBranch[]): BranchialBranch[] {
  return [...branches]
    .sort((a, b) => {
      const aCal = a.why.includes('calendar');
      const bCal = b.why.includes('calendar');
      if (aCal !== bCal) {
        return aCal ? -1 : 1;
      }

      return b.mass - a.mass;
    })
    .slice(0, TOP_K);
}

function mergeScheduled(
  steps: BranchialStep[],
  clusters: WeekForecastCluster[],
  now: Date,
  timeZone: string,
): void {
  const remaining = remainingParts(now, timeZone);
  if (remaining.length === 0) {
    return;
  }

  for (const cluster of clusters.filter(clusterPasses).filter((row) => row.scheduled)) {
    const name = displayNameFor(cluster);
    if (!name) {
      continue;
    }

    const part = topDaypart(cluster.daypart_probs) ?? remaining[0];
    if (!remaining.some((row) => row.id === part.id)) {
      continue;
    }

    let step = steps.find((row) => row.id === part.id);
    if (!step) {
      step = {
        id: part.id,
        label: part.label,
        startTime: now.toISOString(),
        branches: [],
      };
      steps.push(step);
    }

    if (step.branches.some((branch) => branch.title === name)) {
      continue;
    }

    step.branches.unshift({
      id: `${part.id}:${cluster.cluster_id}`,
      title: name,
      l0: isUnknownClass(cluster.l0_class) ? 'LEISURE' : cluster.l0_class,
      mass: Math.max(cluster.p_occur, MIN_BRANCH_MASS),
      why: 'On your calendar.',
      permutations: [],
    });
    step.branches = capBranches(step.branches);
  }
}

export function buildOccupancyTree(args: {
  buckets: ForecastBucket[];
  week?: WeekForecastResponse | null;
  timezone: string;
  now?: Date;
  ready?: boolean;
  stillLearning?: boolean;
}): BranchialTree {
  if (args.ready === false || args.stillLearning) {
    return emptyOccupancyTree();
  }

  const now = args.now ?? new Date();
  const steps: BranchialStep[] = [];

  for (const part of DAYPARTS) {
    const inPart = args.buckets.filter((bucket) => {
      const start = new Date(bucket.start_time);
      if (Number.isNaN(start.getTime()) || start < now) {
        return false;
      }

      const hour = hourInZone(bucket.start_time, args.timezone);

      return hour >= part.startHour && hour < part.endHour;
    });
    if (inPart.length === 0) {
      continue;
    }

    const l0 = averageMaps(inPart.map((bucket) => bucket.l0_probs));
    const l1 = averageMaps(inPart.map((bucket) => bucket.l1_probs));
    const perms = permutationsFrom(l1);
    const branches = topMasses(l0).map((row) => ({
      id: `${part.id}:${row.label}`,
      title: row.label,
      l0: row.label,
      mass: row.mass,
      why: 'From your usual rhythm.',
      permutations: perms,
    }));
    if (branches.length === 0) {
      continue;
    }

    steps.push({
      id: part.id,
      label: part.label,
      startTime: inPart[0].start_time,
      branches,
    });
  }

  const todayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: args.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

  const todayClusters =
    args.week?.days.find((day) => day.date === todayKey)?.clusters ?? [];
  mergeScheduled(steps, todayClusters, now, args.timezone);

  return {
    question: 'What happens next',
    guessed: false,
    steps: sortSteps(steps).filter((step) => step.branches.length > 0),
  };
}

function overlayTitle(title: string, fallback?: string): string {
  const trimmed = title.trim();
  if (!trimmed || !isDisplayableLabel(trimmed)) {
    return fallback || trimmed;
  }

  return trimmed;
}

export function mergeGuess(occupancy: BranchialTree, guessed: BranchialTree): BranchialTree {
  const byStep = new Map(guessed.steps.map((step) => [step.id, step]));

  return {
    question: guessed.question || occupancy.question,
    guessed: true,
    steps: occupancy.steps.map((step) => {
      const overlay = byStep.get(step.id);
      if (!overlay || overlay.branches.length === 0) {
        return step;
      }

      return {
        ...step,
        branches: overlay.branches.slice(0, 4).map((branch, index) => {
          const fallback = step.branches[Math.min(index, step.branches.length - 1)];
          const title = overlayTitle(branch.title, fallback?.title);
          const overlayPerms = (branch.permutations ?? [])
            .filter((row) => isDisplayableLabel(row.title))
            .slice(0, 4);

          return {
            id: branch.id || fallback?.id || `${step.id}:${index}`,
            title: title || fallback?.title || '',
            l0: isUnknownClass(branch.l0) ? (fallback?.l0 ?? 'LEISURE') : branch.l0,
            mass: Number.isFinite(branch.mass) ? branch.mass : (fallback?.mass ?? 0),
            why: branch.why || fallback?.why || '',
            permutations: overlayPerms.length > 0 ? overlayPerms : (fallback?.permutations ?? []),
          };
        }),
      };
    }),
  };
}
