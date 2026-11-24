import { ConflictException, ForbiddenException } from '@nestjs/common';

import { IngestResetService } from '../IngestResetService';

/**
 * The reset TRUNCATES, so it cannot take one account's rows and leave another's.
 * So the guard is about WHOSE data is in range, and these specs pin it: it runs
 * on the personal appliance it was written for, it refuses where it would take
 * somebody else's rows with it, it checks every table it empties (not just the
 * ones it names first), and it checks inside the transaction that truncates.
 */

const stubLogger = () =>
  ({ setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn() }) as never;

const CALLER = '00000000-0000-0000-0000-0000000000aa';

/**
 * A DataSource whose transaction runs against a manager that records every
 * statement, answers each EXISTS probe from `foreign`, and counts everything as
 * empty. `dataSource.query` is a trap: the reset must do nothing outside its
 * transaction.
 */
function build(foreign: string[] = []) {
  const statements: Array<{ sql: string; params?: unknown[] }> = [];

  const manager = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params });

      if (sql.startsWith('SELECT EXISTS')) {
        const table = /FROM "(\w+)"\."(\w+)"/.exec(sql);

        return [{ present: table != null && foreign.includes(`${table[1]}.${table[2]}`) }];
      }

      if (sql.startsWith('SELECT count(*)')) {
        return [{ count: '0' }];
      }

      if (sql.includes('pipeline_state')) {
        return [{ count: 3 }];
      }

      return [[], 0];
    }),
  };

  const dataSource = {
    query: jest.fn(),
    transaction: jest.fn(async (body: (m: unknown) => Promise<unknown>) => body(manager)),
  };

  const indexOf = (predicate: (sql: string) => boolean) => statements.findIndex(({ sql }) => predicate(sql));

  return {
    service: new IngestResetService(dataSource as never, stubLogger()),
    dataSource,
    manager,
    statements,
    indexOf,
  };
}

describe('IngestResetService', () => {
  it('resets when the caller is the only person with data — the personal appliance', async () => {
    const { service, manager, dataSource } = build();

    const result = await service.reset({ userId: CALLER });

    expect(result.truncated).toEqual(
      expect.arrayContaining(['ci.events', 'ci.communications', 'ci.files', 'ci_search.embeddings']),
    );
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('TRUNCATE TABLE'));
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('refuses, and truncates nothing, when another account still holds rows', async () => {
    const { service, statements } = build(['ci.events']);

    await expect(service.reset({ userId: CALLER })).rejects.toBeInstanceOf(ForbiddenException);

    // Refused before any truncate or delete, and the transaction rolls back on the throw.
    expect(statements.some(({ sql }) => sql.startsWith('TRUNCATE') || sql.startsWith('DELETE'))).toBe(false);
  });

  it('names the tables that stopped it, so the refusal is actionable', async () => {
    const { service } = build(['ci.communications', 'ci_search.vectors']);

    await expect(service.reset({ userId: CALLER })).rejects.toThrow(/ci\.communications, ci_search\.vectors/);
  });

  it('checks the search index too, not only the ingest destinations', async () => {
    const { service } = build(['ci_search.embeddings']);

    await expect(service.reset({ userId: CALLER })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('answers a lock timeout with a 409 that says nothing changed, not a 500', async () => {
    const { service, manager, statements } = build();
    const respond = manager.query.getMockImplementation();

    if (!respond) {
      throw new Error('build() always installs a query implementation');
    }

    manager.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('LOCK TABLE')) {
        throw Object.assign(new Error('canceling statement due to lock timeout'), {
          driverError: { code: '55P03' },
        });
      }

      return respond(sql, params);
    });

    const refusal = service.reset({ userId: CALLER });

    await expect(refusal).rejects.toBeInstanceOf(ConflictException);
    await expect(refusal).rejects.toThrow(/Nothing was changed/);
    expect(statements.some(({ sql }) => sql.startsWith('TRUNCATE'))).toBe(false);
  });

  it('passes any other database error through unchanged', async () => {
    const { service, manager } = build();
    const failure = Object.assign(new Error('relation does not exist'), { code: '42P01' });

    manager.query.mockRejectedValueOnce(failure);

    await expect(service.reset({ userId: CALLER })).rejects.toBe(failure);
  });

  it.each([
    'ci.files',
    'ci.file_chunks',
    'ci.unfurls',
    'ci.reminders',
    'ci.capture_events',
    'ci.event_candidates',
    'hbpe.content_context',
  ])('checks %s, which the truncate empties because it hangs off an ingest table', async (table) => {
    // These went out with TRUNCATE ... CASCADE for every account and were never probed.
    const { service, statements } = build([table]);

    await expect(service.reset({ userId: CALLER })).rejects.toThrow(table);
    expect(statements.some(({ sql }) => sql.startsWith('TRUNCATE'))).toBe(false);
  });

  it('locks every table it clears, then probes, then truncates, all on the one transaction', async () => {
    const { service, indexOf, statements } = build();

    await service.reset({ userId: CALLER });

    const lock = indexOf((sql) => sql.startsWith('LOCK TABLE'));
    const firstProbe = indexOf((sql) => sql.startsWith('SELECT EXISTS'));
    const truncate = indexOf((sql) => sql.startsWith('TRUNCATE'));

    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(firstProbe);
    expect(firstProbe).toBeLessThan(truncate);

    const lockSql = statements[lock].sql;

    for (const table of [
      '"ci"."events"',
      '"ci"."files"',
      '"hbpe"."l1_event_cluster"',
      '"ci_search"."embeddings"',
    ]) {
      expect(lockSql).toContain(table);
    }

    expect(lockSql).toContain('ACCESS EXCLUSIVE');
  });

  it('names every table it truncates and never cascades, so a new foreign key fails loudly', async () => {
    const { service, statements } = build();

    await service.reset({ userId: CALLER });

    const truncate = statements.find(
      ({ sql }) => sql.startsWith('TRUNCATE') && sql.includes('"ci"."events"'),
    );

    expect(truncate?.sql).not.toMatch(/CASCADE/i);

    for (const table of [
      '"ci"."files"',
      '"ci"."message_files"',
      '"ci"."reminders"',
      '"hbpe"."l2_content_cluster"',
    ]) {
      expect(truncate?.sql).toContain(table);
    }
  });

  it('scopes every probe, the entity delete and the queue delete to the caller', async () => {
    const { service, statements } = build();

    await service.reset({ userId: CALLER });

    const probes = statements.filter(({ sql }) => sql.startsWith('SELECT EXISTS'));

    expect(probes.length).toBeGreaterThanOrEqual(16);

    for (const { sql, params } of probes) {
      expect(sql).toContain('user_id <> $1::uuid');
      expect(params).toEqual([CALLER]);
    }

    const entities = statements.find(({ sql }) => sql.startsWith('DELETE FROM ci.entities'));

    expect(entities?.sql).toContain('owner_user_id = $1::uuid');
    expect(entities?.params).toEqual([CALLER]);

    const jobs = statements.find(({ sql }) => sql.startsWith('DELETE FROM pgboss.job'));

    expect(jobs?.sql).toContain("data->>'userId' = $2");
    expect(jobs?.params).toEqual(['search-index', CALLER]);
  });

  it("re-opens the caller's index ledger, so the pipeline re-embeds what the reset left", async () => {
    const { service, statements } = build();

    const result = await service.reset({ userId: CALLER });

    const reopen = statements.find(({ sql }) => sql.includes('pipeline_state'));

    expect(reopen?.sql).toContain('SET stage_version = 0');
    expect(reopen?.params).toEqual([CALLER]);
    expect(result.ledgerRowsReopened).toBe(3);
  });
});
