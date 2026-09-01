import type { UserServiceContext } from '@ci/common/context';

import type { PlaceForecastLogEntity } from '../entities/PlaceForecastLogEntity';
import type { PlaceTransitionEntity } from '../entities/PlaceTransitionEntity';

import type { BuildClustersOptions, PlaceClusterService } from './PlaceClusterService';
import { PlaceTransitionService } from './PlaceTransitionService';
import type { PositionFix, StayPoint } from './stayPoints';
import type { BuildClustersResult, PlaceClusterSnapshot } from './types';

const USER = '00000000-0000-0000-0000-0000000000aa';
const CONTEXT: UserServiceContext = { userId: USER };
// A Wednesday, 09:00 UTC.
const AT = new Date('2026-07-08T09:00:00Z');

const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

function cluster(id: string, overrides: Partial<PlaceClusterSnapshot> = {}): PlaceClusterSnapshot {
  return {
    id,
    lat: 40.0,
    lng: -73.0,
    radiusM: 150,
    label: null,
    visitCount: 1,
    firstSeen: new Date('2026-07-01T00:00:00Z'),
    lastSeen: new Date('2026-07-07T00:00:00Z'),
    ...overrides,
  };
}

function transition(
  fromCluster: string,
  toCluster: string,
  hourBucket: number,
  dow: number,
  decayedCount: number,
): PlaceTransitionEntity {
  return {
    userId: USER,
    fromCluster,
    toCluster,
    hourBucket,
    dow,
    decayedCount,
    updatedAt: AT,
  };
}

function makeMocks() {
  const transitionRepository = {
    find: jest.fn<Promise<PlaceTransitionEntity[]>, [unknown]>(async () => []),
    delete: jest.fn<Promise<unknown>, [unknown]>(async () => ({})),
    insert: jest.fn<Promise<unknown>, [Array<Record<string, unknown>>]>(async () => ({})),
  };
  const forecastLogRepository = {
    find: jest.fn<Promise<PlaceForecastLogEntity[]>, [unknown]>(async () => []),
    insert: jest.fn<Promise<unknown>, [unknown]>(async () => ({})),
    update: jest.fn<Promise<unknown>, [unknown, unknown]>(async () => ({})),
  };
  const clusterService = {
    getClusters: jest.fn<Promise<PlaceClusterSnapshot[]>, [UserServiceContext]>(async () => []),
    buildClusters: jest.fn<Promise<BuildClustersResult>, [UserServiceContext, BuildClustersOptions?]>(
      async () => ({ clusters: [], visits: [], windowEnd: AT }),
    ),
    getPositionWindow: jest.fn<Promise<PositionFix[]>, [UserServiceContext, Date, Date]>(async () => []),
    detectWindowStays: jest.fn<StayPoint[], [PositionFix[]]>(() => []),
  };

  const service = new PlaceTransitionService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transitionRepository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    forecastLogRepository as any,
    clusterService as unknown as PlaceClusterService,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { service, transitionRepository, forecastLogRepository, clusterService };
}

describe('PlaceTransitionService.predictNext', () => {
  it('ranks the exact (hour, dow) bucket and logs the prediction', async () => {
    const { service, transitionRepository, forecastLogRepository, clusterService } = makeMocks();
    const home = cluster('home', { lastSeen: new Date('2026-07-08T08:00:00Z'), label: 'Home' });
    const office = cluster('office', { lat: 40.02, label: 'Office' });
    const gym = cluster('gym', { lat: 40.04 });
    clusterService.getClusters.mockResolvedValueOnce([home, office, gym]);
    transitionRepository.find.mockResolvedValueOnce([
      transition('home', 'office', 9, 3, 3),
      transition('home', 'gym', 9, 3, 1),
    ]);

    const forecast = await service.predictNext(CONTEXT, { k: 5, horizonHours: 4, at: AT });

    expect(forecast.status).toBe('OK');
    expect(forecast.backoffLevel).toBe('FROM_HOUR_DOW');
    expect(forecast.predictions).toEqual([
      {
        clusterId: 'office',
        label: 'Office',
        lat: 40.02,
        lng: -73.0,
        probability: 0.75,
        visitCount: 1,
        lastSeen: office.lastSeen,
      },
      {
        clusterId: 'gym',
        label: null,
        lat: 40.04,
        lng: -73.0,
        probability: 0.25,
        visitCount: 1,
        lastSeen: gym.lastSeen,
      },
    ]);
    expect(forecast.heatGrid.length).toBeGreaterThan(0);

    expect(transitionRepository.find).toHaveBeenCalledWith({
      where: { userId: USER, fromCluster: 'home' },
    });
    expect(forecastLogRepository.insert).toHaveBeenCalledWith({
      userId: USER,
      predictedAt: AT,
      horizonHours: 4,
      predictions: [
        { cluster_id: 'office', prob: 0.75 },
        { cluster_id: 'gym', prob: 0.25 },
      ],
      scored: false,
    });
  });

  it('falls back to the global visit prior when the cluster has no transitions', async () => {
    const { service, transitionRepository, clusterService } = makeMocks();
    clusterService.getClusters.mockResolvedValueOnce([
      cluster('home', { visitCount: 5 }),
      cluster('office', { visitCount: 3, lat: 40.02 }),
      cluster('gym', { visitCount: 1, lat: 40.04 }),
    ]);
    transitionRepository.find.mockResolvedValueOnce([]);

    const forecast = await service.predictNext(CONTEXT, { at: AT });

    expect(forecast.backoffLevel).toBe('GLOBAL_PRIOR');
    expect(forecast.predictions.map((p) => p.clusterId)).toEqual(['office', 'gym']);
    expect(forecast.predictions[0].probability).toBeCloseTo(0.75, 10);
  });

  it('reports NO_HISTORY (and logs nothing) when there are no clusters', async () => {
    const { service, forecastLogRepository, clusterService } = makeMocks();
    clusterService.getClusters.mockResolvedValueOnce([]);

    const forecast = await service.predictNext(CONTEXT, { at: AT });

    expect(forecast.status).toBe('NO_HISTORY');
    expect(forecast.predictions).toEqual([]);
    expect(forecastLogRepository.insert).not.toHaveBeenCalled();
  });
});

describe('PlaceTransitionService.rebuild', () => {
  it('rebuilds transitions from the visit sequence (delete-then-insert)', async () => {
    const { service, transitionRepository, clusterService } = makeMocks();
    clusterService.buildClusters.mockResolvedValueOnce({
      clusters: [cluster('home'), cluster('office', { lat: 40.02 })],
      visits: [
        { clusterId: 'home', start: new Date('2026-07-08T07:00:00Z'), end: new Date('2026-07-08T08:00:00Z') },
        {
          clusterId: 'office',
          start: new Date('2026-07-08T09:00:00Z'),
          end: new Date('2026-07-08T10:00:00Z'),
        },
      ],
      windowEnd: AT,
    });

    const result = await service.rebuild(CONTEXT, { now: AT });

    expect(result).toEqual({ clusters: 2, transitions: 1 });
    expect(transitionRepository.delete).toHaveBeenCalledWith({ userId: USER });
    expect(transitionRepository.insert).toHaveBeenCalledTimes(1);

    const [rows] = transitionRepository.insert.mock.calls[0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: USER,
      fromCluster: 'home',
      toCluster: 'office',
      hourBucket: 9,
      dow: 3,
    });
  });
});

describe('PlaceTransitionService.scoreLog', () => {
  function logRow(id: string, overrides: Partial<PlaceForecastLogEntity> = {}): PlaceForecastLogEntity {
    return {
      id,
      userId: USER,
      predictedAt: new Date('2026-07-08T00:00:00Z'),
      horizonHours: 4,
      predictions: [{ cluster_id: 'office', prob: 0.8 }],
      actualCluster: null,
      scored: false,
      ...overrides,
    };
  }

  it('fills actual_cluster from the observed stay and computes hit-rate@k', async () => {
    const { service, forecastLogRepository, clusterService } = makeMocks();
    const office = cluster('office', { lat: 40.02 });
    forecastLogRepository.find
      .mockResolvedValueOnce([logRow('p1')]) // unscored, horizon elapsed by AT
      .mockResolvedValueOnce([logRow('p1', { scored: true, actualCluster: 'office' })]);
    clusterService.getClusters.mockResolvedValueOnce([cluster('home'), office]);
    clusterService.detectWindowStays.mockReturnValueOnce([
      {
        lat: office.lat,
        lng: office.lng,
        start: new Date('2026-07-08T01:00:00Z'),
        end: new Date('2026-07-08T02:00:00Z'),
        fixCount: 10,
      },
    ]);

    const score = await service.scoreLog(CONTEXT, { at: AT });

    expect(forecastLogRepository.update).toHaveBeenCalledWith(
      { id: 'p1' },
      { actualCluster: 'office', scored: true },
    );
    expect(score).toEqual({
      scoredNow: 1,
      totalScored: 1,
      withActual: 1,
      hits: 1,
      hitRateAtK: 1,
    });
  });

  it('leaves un-elapsed predictions alone and marks no-stay windows scored with a null actual', async () => {
    const { service, forecastLogRepository, clusterService } = makeMocks();
    forecastLogRepository.find
      .mockResolvedValueOnce([
        logRow('elapsed'),
        logRow('pending', { predictedAt: new Date('2026-07-08T08:00:00Z'), horizonHours: 12 }),
      ])
      .mockResolvedValueOnce([logRow('elapsed', { scored: true, actualCluster: null })]);
    clusterService.getClusters.mockResolvedValueOnce([cluster('home')]);
    clusterService.detectWindowStays.mockReturnValueOnce([]);

    const score = await service.scoreLog(CONTEXT, { at: AT });

    expect(forecastLogRepository.update).toHaveBeenCalledTimes(1);
    expect(forecastLogRepository.update).toHaveBeenCalledWith(
      { id: 'elapsed' },
      { actualCluster: null, scored: true },
    );
    expect(score.scoredNow).toBe(1);
    expect(score.withActual).toBe(0);
    expect(score.hitRateAtK).toBeNull();
  });
});
