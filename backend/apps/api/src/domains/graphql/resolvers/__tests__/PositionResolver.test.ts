import type { RequestContext } from '@ci/common/context';
import type { PositionService } from '@ci/domains/position';

import type { PositionTrackInput } from '../../types/PositionTrackInput';
import { PositionResolver } from '../PositionResolver';

/**
 * `positionTrack` is the map's second geographic read, and the one that
 * actually holds the geography: `mapPins` answers 121 located events on the QA
 * appliance while `ci.position` holds 63,044 GPS fixes nothing had ever
 * queried.
 *
 * These tests pin the contract the trace layer depends on: the caller's own
 * scope and nobody else's, filters passed through verbatim to SQL, and a page
 * handed back whole so the client can keep paging.
 */
describe('PositionResolver — positionTrack', () => {
  const context = { userId: 'user-1' } as RequestContext;

  type TrackCall = {
    startTime?: Date;
    endTime?: Date;
    bbox?: number[];
    first?: number;
    after?: string;
    maxPoints?: number;
  };

  function makeResolver() {
    const calls: Array<{ userId: unknown; options: TrackCall }> = [];

    const positionService = {
      findTrack: jest.fn(async (serviceContext: { userId: string }, options: TrackCall) => {
        calls.push({ userId: serviceContext.userId, options });

        return {
          points: [
            {
              startTime: new Date('2016-04-07T00:38:54Z'),
              endTime: new Date('2016-04-08T01:00:00Z'),
              latitude: 34.0579389,
              longitude: -118.3049389,
              fixCount: 7,
              activityType: 'in_vehicle',
              cursor: 'cursor-1',
            },
          ],
          hasNextPage: true,
          endCursor: 'cursor-1',
          bucketSeconds: 207_360,
          totalCount: 63_044,
        };
      }),
    } as unknown as PositionService;

    return { resolver: new PositionResolver(positionService), calls, positionService };
  }

  it('answers for the signed-in caller and nobody else', async () => {
    const { resolver, calls } = makeResolver();

    await resolver.positionTrack(context, {} as PositionTrackInput);

    expect(calls[0].userId).toBe('user-1');
  });

  it('passes the whole page through, including what the client needs to page on', async () => {
    const { resolver } = makeResolver();

    const page = await resolver.positionTrack(context, {} as PositionTrackInput);

    expect(page.points).toHaveLength(1);
    expect(page.hasNextPage).toBe(true);
    expect(page.endCursor).toBe('cursor-1');
    expect(page.bucketSeconds).toBe(207_360);
    expect(page.totalCount).toBe(63_044);
  });

  it('parses the ISO date filters into instants for the SQL layer', async () => {
    const { resolver, calls } = makeResolver();

    await resolver.positionTrack(context, {
      startTime: '2024-01-01T00:00:00.000Z',
      endTime: '2024-02-01T00:00:00.000Z',
    } as PositionTrackInput);

    expect(calls[0].options.startTime).toEqual(new Date('2024-01-01T00:00:00.000Z'));
    expect(calls[0].options.endTime).toEqual(new Date('2024-02-01T00:00:00.000Z'));
  });

  it('drops an unparseable date instead of erroring the whole map out', async () => {
    const { resolver, calls } = makeResolver();

    // These arrive from URL params. An Invalid Date reaching SQL compares false
    // against every row, which empties the trace with no explanation.
    await resolver.positionTrack(context, {
      startTime: 'last tuesday',
      endTime: '',
    } as PositionTrackInput);

    expect(calls[0].options.startTime).toBeUndefined();
    expect(calls[0].options.endTime).toBeUndefined();
  });

  it('forwards the viewport, page size, cursor and point budget verbatim', async () => {
    const { resolver, calls } = makeResolver();

    await resolver.positionTrack(context, {
      bbox: [-122.6, 37.6, -122.2, 37.9],
      first: 500,
      after: 'cursor-0',
      maxPoints: 5_000,
    } as PositionTrackInput);

    expect(calls[0].options).toMatchObject({
      bbox: [-122.6, 37.6, -122.2, 37.9],
      first: 500,
      after: 'cursor-0',
      maxPoints: 5_000,
    });
  });

  it("works with no input at all — the map's first, unbounded read", async () => {
    const { resolver, calls } = makeResolver();

    const page = await resolver.positionTrack(context);

    // The map opens at a default centre that has nothing to do with this user's
    // history, so its first read is deliberately unfiltered; the server's
    // downsample is what keeps that affordable.
    expect(page.points).toHaveLength(1);
    expect(calls[0].options).toEqual({
      startTime: undefined,
      endTime: undefined,
      bbox: undefined,
      first: undefined,
      after: undefined,
      maxPoints: undefined,
    });
  });
});

describe('PositionResolver — positionTrackExtent', () => {
  const context = { userId: 'user-1' } as RequestContext;

  function makeResolver(extent: { start: Date; end: Date; count: number } | null) {
    const calls: Array<{ userId: unknown; options: unknown }> = [];

    const positionService = {
      getTrackExtent: jest.fn(async (serviceContext: { userId: string }, options: unknown) => {
        calls.push({ userId: serviceContext.userId, options });

        return extent;
      }),
    } as unknown as PositionService;

    return { resolver: new PositionResolver(positionService), calls };
  }

  it('answers for the signed-in caller and nobody else', async () => {
    const extent = {
      start: new Date('2013-05-28T21:02:08Z'),
      end: new Date('2026-08-21T04:56:01Z'),
      count: 63_044,
    };
    const { resolver, calls } = makeResolver(extent);

    const result = await resolver.positionTrackExtent(context, {} as PositionTrackInput);

    expect(calls[0].userId).toBe('user-1');
    expect(result).toEqual(extent);
  });

  it('returns null when the service reports no track, rather than a zeroed extent', async () => {
    const { resolver } = makeResolver(null);

    const result = await resolver.positionTrackExtent(context, {} as PositionTrackInput);

    expect(result).toBeNull();
  });

  it('parses the ISO date filters, same as positionTrack', async () => {
    const { resolver, calls } = makeResolver(null);

    await resolver.positionTrackExtent(context, {
      startTime: '2024-01-01T00:00:00.000Z',
      endTime: '2024-02-01T00:00:00.000Z',
    } as PositionTrackInput);

    expect(calls[0].options).toMatchObject({
      startTime: new Date('2024-01-01T00:00:00.000Z'),
      endTime: new Date('2024-02-01T00:00:00.000Z'),
    });
  });

  it('forwards the viewport when one is supplied', async () => {
    const { resolver, calls } = makeResolver(null);

    await resolver.positionTrackExtent(context, {
      bbox: [-122.6, 37.6, -122.2, 37.9],
    } as PositionTrackInput);

    expect(calls[0].options).toMatchObject({ bbox: [-122.6, 37.6, -122.2, 37.9] });
  });

  it("works with no input at all — the scrubber's first read, before any filter exists", async () => {
    const extent = { start: new Date(0), end: new Date(1), count: 1 };
    const { resolver, calls } = makeResolver(extent);

    const result = await resolver.positionTrackExtent(context);

    expect(result).toEqual(extent);
    expect(calls[0].options).toEqual({
      startTime: undefined,
      endTime: undefined,
      bbox: undefined,
    });
  });
});
