import type { UserServiceContext } from '@ci/common/context';

import { EVENT_HAPPENED_SQL } from './eventHappened';
import { PlaceService } from './PlaceService';

const isGeocodingConfigured = jest.fn<boolean, []>();

jest.mock('@ci/configuration', () => ({
  __esModule: true,
  default: jest.requireActual('@ci/configuration').default,
  isGeocodingConfigured: () => isGeocodingConfigured(),
}));

const USER = '00000000-0000-0000-0000-0000000000aa';
const PLACE = '00000000-0000-0000-0000-0000000000b1';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

/**
 * `pending_enrichment` vs `confirmed` — the reason a zero-visit place needs a
 * status at all: 112 Location entities with genuinely zero visits (geocoding
 * unconfigured, so PROMOTE_PLACE never runs) used to be indistinguishable
 * from a place someone actually never visits.
 */
function makeHarness(options: {
  pipelinePending: boolean;
  visitRows?: Array<{ place_id: string; n: string; first_at: Date | null; last_at: Date | null }>;
}) {
  const query = jest.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('ci.pipeline_state')) {
      return [{ exists: options.pipelinePending }];
    }

    if (sql.includes('FROM ci.events')) {
      return options.visitRows ?? [];
    }

    throw new Error(`unexpected query: ${sql}`);
  });

  const repository = { manager: { query } };

  const service = new PlaceService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { send: jest.fn(async () => []) } as any,
    {
      entityCreated: jest.fn(async () => undefined),
      entityUpdated: jest.fn(async () => undefined),
      entityDeleted: jest.fn(async () => undefined),
      recordMany: jest.fn(async () => undefined),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  );

  return { service, query };
}

describe('PlaceService.getVisitStats status', () => {
  afterEach(() => {
    isGeocodingConfigured.mockReset();
  });

  it('marks a zero-visit place pending_enrichment when geocoding is not configured', async () => {
    isGeocodingConfigured.mockReturnValue(false);
    const { service } = makeHarness({ pipelinePending: false });

    const stats = await service.getVisitStats(CONTEXT, [PLACE]);

    expect(stats.get(PLACE)).toMatchObject({ visitCount: 0, status: 'pending_enrichment' });
  });

  it('marks a zero-visit place pending_enrichment when geocode/place-promotion work is outstanding', async () => {
    isGeocodingConfigured.mockReturnValue(true);
    const { service } = makeHarness({ pipelinePending: true });

    const stats = await service.getVisitStats(CONTEXT, [PLACE]);

    expect(stats.get(PLACE)).toMatchObject({ visitCount: 0, status: 'pending_enrichment' });
  });

  it('marks a zero-visit place confirmed once geocoding is configured and no work is outstanding', async () => {
    isGeocodingConfigured.mockReturnValue(true);
    const { service } = makeHarness({ pipelinePending: false });

    const stats = await service.getVisitStats(CONTEXT, [PLACE]);

    expect(stats.get(PLACE)).toMatchObject({ visitCount: 0, status: 'confirmed' });
  });

  it('marks a place with at least one visit confirmed even with enrichment outstanding elsewhere', async () => {
    // Enrichment being behind for OTHER places cannot make an already-counted
    // visit on THIS place less real.
    isGeocodingConfigured.mockReturnValue(false);
    const { service } = makeHarness({
      pipelinePending: true,
      visitRows: [
        { place_id: PLACE, n: '3', first_at: new Date('2026-01-01'), last_at: new Date('2026-02-01') },
      ],
    });

    const stats = await service.getVisitStats(CONTEXT, [PLACE]);

    expect(stats.get(PLACE)).toMatchObject({ visitCount: 3, status: 'confirmed' });
  });

  it('counts only events that happened: the visit query applies the shared predicate on the event alias', async () => {
    // The filtering is SQL, so what it does is proven against Postgres in
    // __tests__/PlaceService.visitStats.integration.spec.ts. This pins the
    // text: that the read applies EVENT_HAPPENED_SQL (whose own text
    // eventHappened.spec.ts pins), over the alias it is written for, scoped to
    // the user, with no bind parameter added to the two it always had.
    isGeocodingConfigured.mockReturnValue(true);
    const { service, query } = makeHarness({ pipelinePending: false });

    await service.getVisitStats(CONTEXT, [PLACE]);

    const visitCall = query.mock.calls.find(([sql]) => sql.includes('FROM ci.events'));

    expect(visitCall).toBeDefined();

    const [sql, params] = visitCall!;

    expect(sql).toContain('FROM ci.events event');
    expect(sql).toContain('event.user_id = $1');
    expect(sql).toContain(EVENT_HAPPENED_SQL);
    expect(sql).toContain('MIN(event.start_time)');
    expect(sql).toContain('MAX(event.start_time)');
    expect(params).toEqual([USER, [PLACE]]);
  });

  it('does not query pipeline_state at all when the batch is empty', async () => {
    const { service, query } = makeHarness({ pipelinePending: false });

    const stats = await service.getVisitStats(CONTEXT, []);

    expect(stats.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});
