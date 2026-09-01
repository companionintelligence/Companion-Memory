/** Shared types for the next-place prediction engine. */

import type { BackoffLevel, ClusterVisit, HeatCell } from './transitionMath';

/** A place cluster read back with scalar lat/lng (ST_Y/ST_X in placeSql.ts). */
export interface PlaceClusterSnapshot {
  id: string;
  lat: number;
  lng: number;
  radiusM: number;
  label: string | null;
  /** Stays observed in the last scanned window (see PlaceClusterService docs). */
  visitCount: number;
  firstSeen: Date | null;
  lastSeen: Date | null;
}

/** Output of one cluster-build run over a position window. */
export interface BuildClustersResult {
  /** Every cluster touched by this run, window-recomputed counts included. */
  clusters: PlaceClusterSnapshot[];
  /** The cluster-assigned stays, chronological — the transition model's input. */
  visits: ClusterVisit[];
  /**
   * Inclusive end of the window that was actually scanned. Usually ~now(), but
   * on a stale corpus it is the newest usable fix — see
   * `PlaceClusterService.resolveWindow`. `PlaceTransitionService.rebuild` dates
   * its recency decay from this rather than from the wall clock, so the two
   * cannot drift apart.
   */
  windowEnd: Date;
}

/** One candidate next place with its probability. */
export interface PlacePrediction {
  clusterId: string;
  label: string | null;
  lat: number;
  lng: number;
  probability: number;
  /** Stays in the last scanned window — GraphQL `visits`, not used by the ranker. */
  visitCount: number;
  lastSeen: Date | null;
}

export type PlaceForecastStatus = 'OK' | 'NO_HISTORY';

/** The predictNext output surface (also what the GraphQL layer egresses). */
export interface PlaceForecast {
  status: PlaceForecastStatus;
  predictedAt: Date;
  horizonHours: number;
  k: number;
  /** Which backoff level produced the distribution; null when NO_HISTORY. */
  backoffLevel: BackoffLevel | null;
  predictions: PlacePrediction[];
  heatGrid: HeatCell[];
}

/** scoreLog outcome: how the logged forecasts did once their horizons elapsed. */
export interface PlaceForecastScore {
  /** Rows scored by THIS call. */
  scoredNow: number;
  /** All scored rows for the user (including earlier runs). */
  totalScored: number;
  /** Scored rows where an actual stay was observed inside the horizon. */
  withActual: number;
  /** Rows whose actual cluster appeared in the logged top-k. */
  hits: number;
  /** hits / withActual; null when nothing has an observed actual yet. */
  hitRateAtK: number | null;
}
