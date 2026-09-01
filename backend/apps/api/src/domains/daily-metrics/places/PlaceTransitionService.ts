import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { PlaceForecastLogEntity } from '../entities/PlaceForecastLogEntity';
import { PlaceTransitionEntity } from '../entities/PlaceTransitionEntity';

import { PlaceClusterService, type BuildClustersOptions } from './PlaceClusterService';
import { nearestCluster } from './stayPoints';
import {
  backoffNextPlace,
  buildHeatGrid,
  buildTransitionBuckets,
  globalVisitPrior,
  hourDowInTz,
  type RankedPlace,
  type TransitionBucket,
} from './transitionMath';
import type { PlaceForecast, PlaceForecastScore, PlacePrediction } from './types';

const INSERT_CHUNK_SIZE = 500;
const MS_PER_HOUR = 3_600_000;

export interface RebuildTransitionsOptions extends BuildClustersOptions {
  /** Reference time for the recency decay (defaults to now). */
  now?: Date;
  /** Timezone the hour/dow buckets are computed in (train + predict must match). */
  timezone?: string;
}

export interface PredictNextOptions {
  k?: number;
  horizonHours?: number;
  /** Prediction time (defaults to now); the hour/dow conditioning comes from it. */
  at?: Date;
  timezone?: string;
}

export interface ScoreLogOptions {
  /** Evaluation time (defaults to now); only elapsed horizons are scored. */
  at?: Date;
}

/**
 * The next-place transition model: rebuilds recency-decayed transition counts
 * from the cluster-visit sequence, answers predictNext through the
 * (from, hour, dow) backoff chain, logs every prediction, and scores elapsed
 * predictions against the stays that actually happened (hit-rate@k).
 */
@Injectable()
export class PlaceTransitionService {
  constructor(
    @InjectRepository(PlaceTransitionEntity)
    private readonly transitionRepository: Repository<PlaceTransitionEntity>,
    @InjectRepository(PlaceForecastLogEntity)
    private readonly forecastLogRepository: Repository<PlaceForecastLogEntity>,
    private readonly clusterService: PlaceClusterService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PlaceTransitionService.name);
  }

  /**
   * Rebuild clusters AND transitions for the user's scan window. Transitions
   * are a deterministic function of the visit sequence, so the rebuild is
   * delete-then-insert: idempotent, and a crash mid-way heals on the next run.
   */
  async rebuild(
    context: UserServiceContext,
    options: RebuildTransitionsOptions = {},
  ): Promise<{ clusters: number; transitions: number }> {
    const { clusters, visits, windowEnd } = await this.clusterService.buildClusters(context, options);
    // The decay reference is the END OF THE SCAN WINDOW, not the wall clock.
    // `decayWeight` is 0.5^(age/30d), so measuring a corpus-anchored window's
    // ages against `new Date()` would multiply every bucket in it by the same
    // vanishing constant — 0.5^(217/30) here — which is not wrong in ranking
    // terms but drives the stored `decayed_count` toward the `<= 0` guard in
    // `backoffNextPlace` and makes the persisted numbers meaningless to read.
    // Dating recency from the newest fix keeps the freshest visit at weight
    // 1.0, which is what the column is documented to mean. On a live appliance
    // windowEnd is ~now(), so this is unchanged for the healthy case.
    const now = options.now ?? windowEnd;
    const buckets = buildTransitionBuckets(visits, { now, timezone: options.timezone ?? 'UTC' });

    await this.transitionRepository.delete({ userId: context.userId });

    for (let offset = 0; offset < buckets.length; offset += INSERT_CHUNK_SIZE) {
      const chunk = buckets.slice(offset, offset + INSERT_CHUNK_SIZE).map((bucket) => ({
        userId: context.userId,
        fromCluster: bucket.fromCluster,
        toCluster: bucket.toCluster,
        hourBucket: bucket.hourBucket,
        dow: bucket.dow,
        decayedCount: bucket.decayedCount,
        updatedAt: now,
      }));

      await this.transitionRepository.insert(chunk);
    }

    this.logger.log('Rebuilt place transitions', {
      userId: context.userId,
      clusters: clusters.length,
      visits: visits.length,
      transitions: buckets.length,
    });

    return { clusters: clusters.length, transitions: buckets.length };
  }

  /**
   * Top-k next-place prediction for the current (= most recently visited)
   * cluster, conditioned on the prediction time's hour/dow with backoff:
   * (from, hour, dow) -> (from, hour+/-1) -> (from) -> global visit prior.
   * Every non-empty prediction is logged to ci_derived.place_forecast_log
   * so scoreLog can later measure hit-rate@k.
   */
  async predictNext(context: UserServiceContext, options: PredictNextOptions = {}): Promise<PlaceForecast> {
    const at = options.at ?? new Date();
    const k = Math.min(Math.max(options.k ?? 5, 1), 25);
    const horizonHours = Math.min(Math.max(options.horizonHours ?? 4, 1), 168);

    const clusters = await this.clusterService.getClusters(context);
    const empty: PlaceForecast = {
      status: 'NO_HISTORY',
      predictedAt: at,
      horizonHours,
      k,
      backoffLevel: null,
      predictions: [],
      heatGrid: [],
    };

    if (clusters.length === 0) {
      return empty;
    }

    // getClusters orders by last_seen DESC, so rows[0] is the current place.
    const current = clusters[0];
    const rows = await this.transitionRepository.find({
      where: { userId: context.userId, fromCluster: current.id },
    });
    const buckets: TransitionBucket[] = rows.map((row) => ({
      fromCluster: row.fromCluster,
      toCluster: row.toCluster,
      hourBucket: row.hourBucket,
      dow: row.dow,
      decayedCount: row.decayedCount,
    }));

    const { hour, dow } = hourDowInTz(at, options.timezone ?? 'UTC');
    const backed = backoffNextPlace(buckets, hour, dow, k);
    const level = backed?.level ?? 'GLOBAL_PRIOR';
    const ranked: RankedPlace[] = backed?.ranked ?? globalVisitPrior(clusters, current.id, k);

    if (ranked.length === 0) {
      return empty;
    }

    const byId = new Map(clusters.map((cluster) => [cluster.id, cluster]));
    const predictions: PlacePrediction[] = ranked
      .filter((place) => byId.has(place.clusterId))
      .map((place) => {
        const cluster = byId.get(place.clusterId)!;

        return {
          clusterId: place.clusterId,
          label: cluster.label,
          lat: cluster.lat,
          lng: cluster.lng,
          probability: place.probability,
          visitCount: cluster.visitCount,
          lastSeen: cluster.lastSeen,
        };
      });

    await this.forecastLogRepository.insert({
      userId: context.userId,
      predictedAt: at,
      horizonHours,
      predictions: ranked.map((place) => ({ cluster_id: place.clusterId, prob: place.probability })),
      scored: false,
    });

    this.logger.log('Predicted next place', {
      userId: context.userId,
      horizonHours,
      k,
      backoffLevel: level,
      topProbability: predictions[0]?.probability,
    });

    return {
      status: 'OK',
      predictedAt: at,
      horizonHours,
      k,
      backoffLevel: level,
      predictions,
      heatGrid: buildHeatGrid(
        predictions.map((place) => ({ lat: place.lat, lng: place.lng, weight: place.probability })),
      ),
    };
  }

  /**
   * Score every unscored prediction whose horizon has elapsed: re-detect the
   * stays inside each prediction's window, snap the first one to a cluster,
   * fill actual_cluster (NULL when no stay was observed — still marked scored
   * so it is never rescanned), then report hit-rate@k over all scored rows.
   */
  async scoreLog(context: UserServiceContext, options: ScoreLogOptions = {}): Promise<PlaceForecastScore> {
    const at = options.at ?? new Date();
    const unscored = await this.forecastLogRepository.find({
      where: { userId: context.userId, scored: false },
    });
    const elapsed = unscored.filter(
      (row) => row.predictedAt.getTime() + row.horizonHours * MS_PER_HOUR <= at.getTime(),
    );
    const clusters = await this.clusterService.getClusters(context);

    for (const row of elapsed) {
      const windowEnd = new Date(row.predictedAt.getTime() + row.horizonHours * MS_PER_HOUR);
      const fixes = await this.clusterService.getPositionWindow(context, row.predictedAt, windowEnd);
      const stays = this.clusterService.detectWindowStays(fixes);

      let actualCluster: string | null = null;
      for (const stay of stays) {
        const match = nearestCluster(stay.lat, stay.lng, clusters);
        if (match) {
          actualCluster = match.id;
          break;
        }
      }

      await this.forecastLogRepository.update({ id: row.id }, { actualCluster, scored: true });
    }

    const scored = await this.forecastLogRepository.find({
      where: { userId: context.userId, scored: true },
    });
    const withActual = scored.filter((row) => row.actualCluster !== null);
    const hits = withActual.filter((row) =>
      row.predictions.some((prediction) => prediction.cluster_id === row.actualCluster),
    ).length;

    const score: PlaceForecastScore = {
      scoredNow: elapsed.length,
      totalScored: scored.length,
      withActual: withActual.length,
      hits,
      hitRateAtK: withActual.length > 0 ? hits / withActual.length : null,
    };

    this.logger.log('Scored place forecasts', { userId: context.userId, ...score });

    return score;
  }
}
