import { keysetPaginate, resolvePageShape, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './keysetPaginate';
import { keysetSeekExact } from './keysetSeek';

describe('resolvePageShape', () => {
  it('uses first for forward pagination', () => {
    expect(resolvePageShape({ first: 10 })).toEqual({ limit: 10, isBackward: false });
  });

  it('treats last/before as backward', () => {
    expect(resolvePageShape({ last: 5 })).toEqual({ limit: 5, isBackward: true });
    expect(resolvePageShape({ beforeId: 'x' })).toEqual({ limit: DEFAULT_PAGE_SIZE, isBackward: true });
  });

  it('defaults page size when neither first nor last is given', () => {
    expect(resolvePageShape({})).toEqual({ limit: DEFAULT_PAGE_SIZE, isBackward: false });
    expect(resolvePageShape({ afterId: 'x' })).toEqual({ limit: DEFAULT_PAGE_SIZE, isBackward: false });
  });

  it('clamps an over-large request to MAX_PAGE_SIZE', () => {
    expect(resolvePageShape({ first: 100_000 }).limit).toBe(MAX_PAGE_SIZE);
    expect(resolvePageShape({ last: 100_000 }).limit).toBe(MAX_PAGE_SIZE);
  });

  it('never returns a negative limit', () => {
    expect(resolvePageShape({ first: -5 }).limit).toBe(0);
  });
});

/**
 * What `keysetPaginate` writes and binds, with no database. What the seek MEANS against real rows,
 * microseconds included, is held by `__tests__/keysetPaginate.subMillisecond.integration.spec.ts`:
 * `make test` can pass having run none of those, so the one fact that spec exists for is pinned here
 * too. The cursor row's time is read as TEXT (a `Date` is milliseconds) and bound as that text.
 */
describe('keysetPaginate', () => {
  // timestamptz(6), as Postgres prints it. A `Date` could not carry the last three digits.
  const cursorTime = '2026-05-01 00:00:00.123456+00';
  const cursorId = '018f0000-0000-7000-8000-00000000abcd';

  interface Recorded {
    selects: Array<[string, string?]>;
    addSelects: Array<[string, string?]>;
    wheres: Array<{ sql: string; params?: Record<string, unknown> }>;
    andWheres: Array<{ sql: string; params?: Record<string, unknown> }>;
    orderBy: Array<[string, string]>;
    limit?: number;
    getOne: jest.Mock;
    getRawOne: jest.Mock;
    getMany: jest.Mock;
  }

  /** One recording builder per `createQueryBuilder` call: the count, the cursor lookup, the page. */
  function makeRepo(options: { cursorRow?: { cursor_id: string; cursor_time: string } | undefined }) {
    const builders: Recorded[] = [];

    const repo = {
      createQueryBuilder: jest.fn(() => {
        const recorded: Recorded = {
          selects: [],
          addSelects: [],
          wheres: [],
          andWheres: [],
          orderBy: [],
          getOne: jest.fn(async () => undefined),
          getRawOne: jest.fn(async () => options.cursorRow),
          getMany: jest.fn(async () => []),
        };
        const qb: Record<string, unknown> = {};

        qb.select = jest.fn((sql: string, alias?: string) => {
          recorded.selects.push([sql, alias]);

          return qb;
        });
        qb.addSelect = jest.fn((sql: string, alias?: string) => {
          recorded.addSelects.push([sql, alias]);

          return qb;
        });
        qb.where = jest.fn((sql: string, params?: Record<string, unknown>) => {
          recorded.wheres.push({ sql, params });

          return qb;
        });
        qb.andWhere = jest.fn((sql: string, params?: Record<string, unknown>) => {
          recorded.andWheres.push({ sql, params });

          return qb;
        });
        qb.orderBy = jest.fn((column: string, direction: string) => {
          recorded.orderBy.push([column, direction]);

          return qb;
        });
        qb.addOrderBy = jest.fn((column: string, direction: string) => {
          recorded.orderBy.push([column, direction]);

          return qb;
        });
        qb.limit = jest.fn((value: number) => {
          recorded.limit = value;

          return qb;
        });
        qb.getCount = jest.fn(async () => 0);
        qb.getOne = recorded.getOne;
        qb.getRawOne = recorded.getRawOne;
        qb.getMany = recorded.getMany;
        builders.push(recorded);

        return qb;
      }),
    };

    return { repo, builders };
  }

  const options = { alias: 'content', timeProp: 'createdAt', userId: 'user-1' };
  const found = { cursor_id: cursorId, cursor_time: cursorTime };

  it('reads the cursor row as text, never through an entity, so no microsecond is lost', async () => {
    const { repo, builders } = makeRepo({ cursorRow: found });

    await keysetPaginate(repo as never, { first: 10, afterId: cursorId }, options);

    const lookup = builders[1];

    expect(lookup.selects).toEqual([['content.id', 'cursor_id']]);
    expect(lookup.addSelects).toEqual([['CAST(content.createdAt AS text)', 'cursor_time']]);
    expect(lookup.wheres).toEqual([{ sql: 'content.id = :cursorId', params: { cursorId } }]);
    expect(lookup.getRawOne).toHaveBeenCalledTimes(1);
    // An entity read hands the sort key back as a `Date`: milliseconds.
    expect(lookup.getOne).not.toHaveBeenCalled();
  });

  it('pages forward newest first, seeking past the cursor by its exact text', async () => {
    const { repo, builders } = makeRepo({ cursorRow: found });

    await keysetPaginate(repo as never, { first: 10, afterId: cursorId }, options);

    const page = builders[2];

    expect(page.orderBy).toEqual([
      ['content.createdAt', 'DESC'],
      ['content.id', 'DESC'],
    ]);
    expect(page.limit).toBe(11);
    expect([page.andWheres[0].sql, page.andWheres[0].params]).toEqual(
      keysetSeekExact('content.createdAt', 'content.id', 'DESC', cursorTime, cursorId),
    );
    // The text, as Postgres printed it: not a Date.
    expect(page.andWheres[0].params!.afterTime).toBe(cursorTime);
  });

  it('pages backward oldest first, seeking past the cursor the other way, by the same exact text', async () => {
    const { repo, builders } = makeRepo({ cursorRow: found });

    await keysetPaginate(repo as never, { last: 10, beforeId: cursorId }, options);

    const page = builders[2];

    expect(page.orderBy).toEqual([
      ['content.createdAt', 'ASC'],
      ['content.id', 'ASC'],
    ]);
    expect([page.andWheres[0].sql, page.andWheres[0].params]).toEqual(
      keysetSeekExact('content.createdAt', 'content.id', 'ASC', cursorTime, cursorId),
    );
    expect(page.andWheres[0].params!.afterTime).toBe(cursorTime);
  });

  it('adds no seek, and looks nothing up, when there is no cursor', async () => {
    const { repo, builders } = makeRepo({});

    await keysetPaginate(repo as never, { first: 10 }, options);

    // The count and the page: no lookup builder.
    expect(builders).toHaveLength(2);
    expect(builders[1].andWheres).toEqual([]);
  });

  it('returns an empty page, not the first page, when the cursor row does not exist', async () => {
    const forward = makeRepo({ cursorRow: undefined });
    const backward = makeRepo({ cursorRow: undefined });

    await expect(
      keysetPaginate(forward.repo as never, { first: 10, afterId: cursorId }, options),
    ).resolves.toEqual({ entities: [], hasNextPage: false, hasPreviousPage: false, totalCount: 0 });
    await expect(
      keysetPaginate(backward.repo as never, { last: 10, beforeId: cursorId }, options),
    ).resolves.toEqual({ entities: [], hasNextPage: false, hasPreviousPage: true, totalCount: 0 });

    // Nothing was fetched to fall back on.
    expect(forward.builders.every((builder) => builder.getMany.mock.calls.length === 0)).toBe(true);
  });
});
