import type { ServiceContext } from '@ci/common/context';
import { SYSTEM_USER } from '@ci/common/context';

import { ConnectionSyncJobService } from '../ConnectionSyncJobService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const OTHER_USER = '00000000-0000-0000-0000-0000000000bb';

const CONTEXT: ServiceContext = { userId: USER } as ServiceContext;
const SYSTEM_CONTEXT: ServiceContext = { userId: SYSTEM_USER } as ServiceContext;

/**
 * A spy query builder that records every where()/andWhere()/orderBy() call
 * (SQL fragment + bound params) instead of executing SQL. This is the
 * convention this file's sibling tests use for TypeORM query-builder chains
 * (see ActionService.spec.ts's findForFeed tests) — it proves the SERVICE
 * asks for the right filters, which is exactly what SyncNowService.spec.ts's
 * blanket `search` mock could never catch.
 */
function makeQueryBuilderSpy(results: unknown[] = []) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const qb: Record<string, unknown> = {};
  const chain = (name: string) =>
    jest.fn((...args: unknown[]) => {
      calls.push({ method: name, args });

      return qb;
    });

  qb.where = chain('where');
  qb.andWhere = chain('andWhere');
  qb.orderBy = chain('orderBy');
  qb.addOrderBy = chain('addOrderBy');
  qb.take = chain('take');
  qb.getMany = jest.fn(async () => results);

  return { qb, calls };
}

/**
 * The shape TypeORM's Postgres driver actually resolves `manager.query()` to
 * for an UPDATE — the pair `[rows, rowCount]`, not the RETURNING rows (see
 * `driver/postgres/PostgresQueryRunner.ts`, which special-cases UPDATE/DELETE).
 * Every claim mock below goes through this rather than returning a bare array:
 * a mock that hands back `[]` for "no row matched" is a shape production never
 * produces, and it is precisely what let `rows.length > 0` — always true on the
 * real two-element pair — ship as a green test.
 */
function updateResult(rows: Array<{ id: string }>): [Array<{ id: string }>, number] {
  return [rows, rows.length];
}

function makeService(overrides: { queryBuilderResults?: unknown[]; managerQuery?: jest.Mock } = {}) {
  const { qb, calls } = makeQueryBuilderSpy(overrides.queryBuilderResults);

  const find = jest.fn<Promise<unknown[]>, [unknown]>(async () => []);
  const findOne = jest.fn<Promise<unknown>, [unknown]>(async () => null);
  const save = jest.fn(async (entity: unknown) => entity);
  const deleteFn = jest.fn(async () => ({ affected: 1 }));
  const create = jest.fn((partial: unknown) => partial);
  const managerQuery =
    overrides.managerQuery ?? jest.fn(async (_sql: string, _params?: unknown[]) => updateResult([]));

  const repository = {
    find,
    findOne,
    save,
    delete: deleteFn,
    create,
    createQueryBuilder: jest.fn(() => qb),
    manager: { query: managerQuery },
  };

  const logger = { setContext() {}, log() {}, warn: jest.fn(), error() {} };

  const service = new ConnectionSyncJobService(repository as never, logger as never);

  return { service, find, findOne, save, delete: deleteFn, managerQuery, queryBuilderCalls: calls, logger };
}

function whereFragments(calls: Array<{ method: string; args: unknown[] }>) {
  return calls.filter((c) => c.method === 'where' || c.method === 'andWhere').map((c) => c.args[0] as string);
}

describe('ConnectionSyncJobService.search — query construction', () => {
  it('scopes to the caller by user_id, ANDed with every other filter that is set', async () => {
    const { service, queryBuilderCalls } = makeService();

    await service.search(CONTEXT, {
      connectionId: 'conn-1',
      endpointName: 'messages',
      status: 'pending',
      type: 'incremental',
    });

    const fragments = whereFragments(queryBuilderCalls);
    expect(fragments[0]).toBe('user_id = :userId');
    expect(fragments).toEqual(
      expect.arrayContaining([
        'connection_id = :connectionId',
        'endpoint_name = :endpointName',
        'status = :status',
        'type = :type',
      ]),
    );
    // where() (not andWhere()) is used exactly once, for the tenancy scope.
    expect(queryBuilderCalls.filter((c) => c.method === 'where')).toHaveLength(1);
  });

  it('omits the user_id scope entirely for SYSTEM_USER (the orchestrator polls across all users)', async () => {
    const { service, queryBuilderCalls } = makeService();

    await service.search(SYSTEM_CONTEXT, { status: 'pending' });

    const fragments = whereFragments(queryBuilderCalls);
    expect(fragments).not.toContain('user_id = :userId');
    expect(fragments).toContain('status = :status');
  });

  it('binds the actual filter values as query parameters', async () => {
    const { service, queryBuilderCalls } = makeService();

    await service.search(CONTEXT, { connectionId: 'conn-42', status: 'success' });

    const statusCall = queryBuilderCalls.find((c) => c.args[0] === 'status = :status');
    expect(statusCall?.args[1]).toEqual({ status: 'success' });
    const connectionCall = queryBuilderCalls.find((c) => c.args[0] === 'connection_id = :connectionId');
    expect(connectionCall?.args[1]).toEqual({ connectionId: 'conn-42' });
  });

  it('filters lastTransformed IS NULL (the awaiting-transform guard) when explicitly given null', async () => {
    const { service, queryBuilderCalls } = makeService();

    await service.search(CONTEXT, { status: 'success', lastTransformed: null });

    const fragments = whereFragments(queryBuilderCalls);
    expect(fragments).toContain('last_transformed IS NULL');
  });

  it('filters lastTransformed >= value when given a concrete date, not IS NULL', async () => {
    const cutoff = new Date('2026-01-01T00:00:00Z');
    const { service, queryBuilderCalls } = makeService();

    await service.search(CONTEXT, { lastTransformed: cutoff });

    const fragments = whereFragments(queryBuilderCalls);
    expect(fragments).not.toContain('last_transformed IS NULL');
    expect(fragments).toContain('last_transformed >= :lastTransformed');
    const call = queryBuilderCalls.find((c) => c.args[0] === 'last_transformed >= :lastTransformed');
    expect(call?.args[1]).toEqual({ lastTransformed: cutoff });
  });

  it('adds neither lastTransformed clause when the field is left undefined', async () => {
    const { service, queryBuilderCalls } = makeService();

    await service.search(CONTEXT, { status: 'pending' });

    const fragments = whereFragments(queryBuilderCalls);
    expect(fragments).not.toContain('last_transformed IS NULL');
    expect(fragments).not.toContain('last_transformed >= :lastTransformed');
  });

  it('parses "field:DIRECTION" orderBy into an orderBy() call', async () => {
    const { service, queryBuilderCalls } = makeService();

    await service.search(CONTEXT, { orderBy: 'updated_at:DESC' });

    const orderByCall = queryBuilderCalls.find((c) => c.method === 'orderBy');
    expect(orderByCall?.args).toEqual(['updated_at', 'DESC']);
  });

  it('appends the primary key to the sort, so a bounded search cannot straddle a tie', async () => {
    const { service, queryBuilderCalls } = makeService();

    await service.search(CONTEXT, { orderBy: 'updated_at:DESC', limit: 2 });

    const tiebreak = queryBuilderCalls.find((c) => c.method === 'addOrderBy');
    expect(tiebreak?.args).toEqual(['id', 'DESC']);
  });

  it('pushes a limit down to the query builder rather than trimming the result', async () => {
    const { service, queryBuilderCalls } = makeService({
      queryBuilderResults: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    });

    const rows = await service.search(CONTEXT, { orderBy: 'updated_at:DESC', limit: 2 });

    const take = queryBuilderCalls.find((c) => c.method === 'take');
    expect(take?.args).toEqual([2]);
    // Deliberately NOT trimmed here: the bound is Postgres's to apply, and a
    // service that also sliced would hide a missing LIMIT from this test.
    expect(rows).toHaveLength(3);
  });

  it('orders a bounded search on the primary key when the caller passes no sort', async () => {
    const { service, queryBuilderCalls } = makeService();

    await service.search(CONTEXT, { limit: 1 });

    const orderByCall = queryBuilderCalls.find((c) => c.method === 'orderBy');
    expect(orderByCall?.args).toEqual(['id', 'ASC']);
  });

  it('warns and skips ordering on an invalid direction instead of passing it through to SQL', async () => {
    const { service, queryBuilderCalls, logger } = makeService();

    await service.search(CONTEXT, { orderBy: 'updated_at:SIDEWAYS' as never });

    expect(logger.warn).toHaveBeenCalled();
    expect(queryBuilderCalls.some((c) => c.method === 'orderBy')).toBe(false);
  });

  it('builds a bare (unscoped-by-anything-but-tenancy) query when no filters are given', async () => {
    const { service, queryBuilderCalls } = makeService();

    await service.search(CONTEXT, {});

    expect(queryBuilderCalls).toHaveLength(1); // just the user_id where()
    expect(queryBuilderCalls[0].args[0]).toBe('user_id = :userId');
  });
});

describe('ConnectionSyncJobService tenancy scoping (SYSTEM_USER-conditional idiom)', () => {
  it('findById scopes the lookup to the caller for a non-system user', async () => {
    const { service, findOne } = makeService();

    await service.findById(CONTEXT, 'job-1');

    const [options] = findOne.mock.calls[0] as [{ where: { userId?: string } }];
    expect(options.where.userId).toBe(USER);
  });

  it('findById omits the owner scope for SYSTEM_USER', async () => {
    const { service, findOne } = makeService();

    await service.findById(SYSTEM_CONTEXT, 'job-1');

    const [options] = findOne.mock.calls[0] as [{ where: { userId?: string } }];
    expect(options.where.userId).toBeUndefined();
  });

  it("update returns null (no save) when the job is not found under the caller's scope", async () => {
    const { service, save } = makeService();

    const result = await service.update(CONTEXT, 'job-1', { status: 'success' });

    expect(result).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('delete scopes both the existence check and the DELETE itself to the caller', async () => {
    const { service, findOne, delete: deleteFn } = makeService({});
    (findOne as jest.Mock).mockResolvedValueOnce({ id: 'job-1', userId: USER });

    const result = await service.delete(CONTEXT, 'job-1');

    expect(result).toBe(true);
    expect(deleteFn).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1', userId: USER }));
  });

  it("delete returns false without deleting when the job cannot be found under the caller's scope", async () => {
    const { service, delete: deleteFn } = makeService();

    const result = await service.delete({ userId: OTHER_USER } as ServiceContext, 'job-1');

    expect(result).toBe(false);
    expect(deleteFn).not.toHaveBeenCalled();
  });
});

/**
 * `fetched_by_executor` is what the transform sweep trusts a job's `data` on, so only the sync
 * executor (which runs as the system) may set it, and the sweep only selects rows that have it.
 */
describe('ConnectionSyncJobService — the executor mark', () => {
  it('refuses to set it from a user-scoped write, and saves nothing', async () => {
    const { service, findOne, save } = makeService();
    (findOne as jest.Mock).mockResolvedValue({ id: 'job-1', userId: USER });

    await expect(service.update(CONTEXT, 'job-1', { fetchedByExecutor: true })).rejects.toThrow(
      'Only the sync executor marks a sync job as fetched',
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('sets it for the system context', async () => {
    const { service, findOne, save } = makeService();
    (findOne as jest.Mock).mockResolvedValue({ id: 'job-1', userId: USER });

    await service.update(SYSTEM_CONTEXT, 'job-1', { status: 'success', fetchedByExecutor: true });

    const [saved] = save.mock.calls[0] as [{ fetchedByExecutor?: boolean }];
    expect(saved.fetchedByExecutor).toBe(true);
  });

  it('refuses a user-scoped change of endpoint or type on a fetched job waiting for its transform', async () => {
    const { service, findOne, save } = makeService();
    const fetched = {
      id: 'job-1',
      userId: USER,
      endpointName: 'posts',
      type: 'historical',
      fetchedByExecutor: true,
      lastTransformed: null,
    };

    (findOne as jest.Mock).mockResolvedValue({ ...fetched });
    await expect(service.update(CONTEXT, 'job-1', { endpointName: 'photos' })).rejects.toThrow(
      'A sync job that has fetched data keeps its endpoint and type',
    );

    (findOne as jest.Mock).mockResolvedValue({ ...fetched });
    await expect(service.update(CONTEXT, 'job-1', { type: 'incremental' })).rejects.toThrow(
      'A sync job that has fetched data keeps its endpoint and type',
    );
    expect(save).not.toHaveBeenCalled();

    // The same values, or other descriptive fields, are still the client's to write.
    (findOne as jest.Mock).mockResolvedValue({ ...fetched });
    await service.update(CONTEXT, 'job-1', { endpointName: 'posts', properties: { note: 'x' } });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('search can ask for executor-fetched rows on active connections only', async () => {
    const { service, queryBuilderCalls } = makeService();

    await service.search(SYSTEM_CONTEXT, { fetchedByExecutor: true, connectionActive: true });

    const fragments = whereFragments(queryBuilderCalls);
    expect(fragments).toContain('fetched_by_executor = true');
    expect(fragments).toContain(
      `EXISTS (SELECT 1 FROM ci.connections c WHERE c.id = "syncJob".connection_id AND c.active)`,
    );
  });

  it('search adds neither filter unless asked', async () => {
    const { service, queryBuilderCalls } = makeService();

    await service.search(SYSTEM_CONTEXT, { status: 'success' });

    const fragments = whereFragments(queryBuilderCalls).join(' ');
    expect(fragments).not.toContain('fetched_by_executor');
    expect(fragments).not.toContain('ci.connections');
  });
});

describe('ConnectionSyncJobService.markAsCompleted', () => {
  it('stamps completedAt and forwards status/error through update()', async () => {
    const { service, findOne, save } = makeService();
    (findOne as jest.Mock)
      .mockResolvedValueOnce({ id: 'job-1', userId: USER })
      .mockResolvedValueOnce({ id: 'job-1', userId: USER, status: 'failed' });

    await service.markAsCompleted(CONTEXT, 'job-1', 'failed', { error: 'boom' });

    const [saved] = save.mock.calls[0] as [{ status: string; completedAt: Date; error?: unknown }];
    expect(saved.status).toBe('failed');
    expect(saved.completedAt).toBeInstanceOf(Date);
    expect(saved.error).toEqual({ error: 'boom' });
  });

  it('omits the error field entirely when none is given', async () => {
    const { service, findOne, save } = makeService();
    (findOne as jest.Mock)
      .mockResolvedValueOnce({ id: 'job-1', userId: USER })
      .mockResolvedValueOnce({ id: 'job-1', userId: USER, status: 'success' });

    await service.markAsCompleted(CONTEXT, 'job-1', 'success');

    const [saved] = save.mock.calls[0] as [{ error?: unknown }];
    expect('error' in saved).toBe(false);
  });
});

describe('ConnectionSyncJobService.claimPending', () => {
  it('issues a single atomic UPDATE gated on status = pending and reports whether it won', async () => {
    const managerQuery = jest.fn(async (_sql: string, _params?: unknown[]) =>
      updateResult([{ id: 'job-1' }]),
    );
    const { service } = makeService({ managerQuery });

    const claimed = await service.claimPending(SYSTEM_CONTEXT, 'job-1');

    expect(claimed).toBe(true);
    const [sql, params] = managerQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("SET status = 'in_progress'");
    expect(sql).toContain("WHERE id = $1::uuid AND status = 'pending'");
    expect(sql).toContain('RETURNING id');
    expect(params).toEqual(['job-1']);
  });

  it("returns false when RETURNING comes back empty (the row was not 'pending')", async () => {
    const { service } = makeService({ managerQuery: jest.fn(async () => updateResult([])) });

    const claimed = await service.claimPending(SYSTEM_CONTEXT, 'job-1');

    expect(claimed).toBe(false);
  });

  it('scopes the claim to the caller for a non-system context', async () => {
    const managerQuery = jest.fn(async (_sql: string, _params?: unknown[]) =>
      updateResult([{ id: 'job-1' }]),
    );
    const { service } = makeService({ managerQuery });

    await service.claimPending(CONTEXT, 'job-1');

    const [sql, params] = managerQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('AND user_id = $2::uuid');
    expect(params).toEqual(['job-1', USER]);
  });
});

describe('ConnectionSyncJobService.claimTransform', () => {
  it('issues a single atomic UPDATE gated on an unset/stale claim and no completion, reporting whether it won', async () => {
    const managerQuery = jest.fn(async (_sql: string, _params?: unknown[]) =>
      updateResult([{ id: 'job-1' }]),
    );
    const { service } = makeService({ managerQuery });

    const claimed = await service.claimTransform(SYSTEM_CONTEXT, 'job-1');

    expect(claimed).toBe(true);
    const [sql, params] = managerQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('SET transform_claimed_at = now()');
    expect(sql).toContain('AND last_transformed IS NULL');
    expect(sql).toContain(
      "AND (transform_claimed_at IS NULL OR transform_claimed_at < now() - interval '1 hour')",
    );
    expect(sql).toContain('RETURNING id');
    expect(params).toEqual(['job-1']);
  });

  it('returns false when RETURNING comes back empty (already claimed, or already transformed)', async () => {
    const { service } = makeService({ managerQuery: jest.fn(async () => updateResult([])) });

    const claimed = await service.claimTransform(SYSTEM_CONTEXT, 'job-1');

    expect(claimed).toBe(false);
  });

  it('scopes the claim to the caller for a non-system context', async () => {
    const managerQuery = jest.fn(async (_sql: string, _params?: unknown[]) =>
      updateResult([{ id: 'job-1' }]),
    );
    const { service } = makeService({ managerQuery });

    await service.claimTransform(CONTEXT, 'job-1');

    const [sql, params] = managerQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('AND user_id = $2::uuid');
    expect(params).toEqual(['job-1', USER]);
  });
});
