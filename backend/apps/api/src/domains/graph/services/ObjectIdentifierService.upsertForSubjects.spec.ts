import { classifyDatabaseError } from '@ci/common/persistence';

import { ObjectIdentifierService } from './ObjectIdentifierService';

const OWNER = '00000000-0000-0000-0000-0000000000aa';
const SUBJECT_A = '00000000-0000-0000-0000-0000000000bb';
const SUBJECT_B = '00000000-0000-0000-0000-0000000000cc';

/**
 * ObjectIdentifierService.upsertForSubjects is the write side of the
 * barcode/serial dedup index (`ci.object_identifiers`) — the object-identity
 * counterpart of EntityIdentifierService.upsertForEntities, which this file
 * mirrors both in fixture shape and in what it asserts (normalize-then-insert,
 * in-batch dedup-to-first-claimant, chunked batched INSERT, partial-chunk
 * failure handling). Before this file the DB-facing half of the barcode index
 * had zero coverage even though its normalizer (normalizeObjectIdentifier)
 * was thoroughly unit tested.
 */

function makeInsertBuilder() {
  const calls = { values: [] as unknown[], valuesCalls: [] as unknown[][], orIgnore: 0 };
  const builder: Record<string, unknown> = {};
  builder.insert = () => builder;
  builder.into = () => builder;
  builder.values = (rows: unknown[]) => {
    calls.values = rows;
    calls.valuesCalls.push(rows);

    return builder;
  };

  builder.orIgnore = () => {
    calls.orIgnore += 1;

    return builder;
  };

  // Simulate ON CONFLICT DO NOTHING: everything in the chunk "inserts" unless a
  // test overrides execute() directly.
  builder.execute = async () => ({ identifiers: (calls.values as unknown[]).map(() => ({})) });

  return { builder, calls };
}

function makeService(
  overrides: {
    insertBuilder?: ReturnType<typeof makeInsertBuilder>;
    columnsPerRow?: number;
  } = {},
) {
  const insert = overrides.insertBuilder ?? makeInsertBuilder();

  const repository = {
    createQueryBuilder: () => insert.builder,
    metadata: { columns: { length: overrides.columnsPerRow ?? 14 } },
  };

  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };

  const service = new ObjectIdentifierService(repository as never, logger as never);

  return { service, insert };
}

describe('ObjectIdentifierService.upsertForSubjects', () => {
  it('normalizes, computes the qualifier, and inserts ON CONFLICT DO NOTHING', async () => {
    const { service, insert } = makeService();

    const inserted = await service.upsertForSubjects(OWNER, [
      {
        subjectType: 'object_instance',
        subjectId: SUBJECT_A,
        identifiers: [{ namespace: 'gtin', value: '012345678905' }],
        source: 'receipt_ocr',
      },
    ]);

    expect(insert.calls.orIgnore).toBe(1);
    expect(insert.calls.values).toEqual([
      expect.objectContaining({
        ownerUserId: OWNER,
        subjectType: 'object_instance',
        subjectId: SUBJECT_A,
        namespace: 'gtin',
        valueNormalized: '00012345678905',
        // UPC-A zero-padded to GTIN-14 — the raw and normalized forms differ,
        // so the original is preserved.
        valueRaw: '012345678905',
        qualifier: '', // gtin is globally unique -> no qualifier
        confidence: 1.0,
        isPrimary: false,
        source: 'receipt_ocr',
      }),
    ]);
    expect(inserted).toBe(1);
  });

  it('drops a value that fails to normalize without failing the batch', async () => {
    const { service, insert } = makeService();

    const inserted = await service.upsertForSubjects(OWNER, [
      {
        subjectType: 'object_instance',
        subjectId: SUBJECT_A,
        identifiers: [
          { namespace: 'gtin', value: '012345678904' }, // bad check digit
          { namespace: 'sku', value: ' ab-1234-xl ' },
        ],
      },
    ]);

    expect(insert.calls.values).toEqual([
      expect.objectContaining({ namespace: 'sku', valueNormalized: 'AB-1234-XL' }),
    ]);
    expect(inserted).toBe(1);
  });

  it('is a no-op (no query) when nothing in the batch normalizes', async () => {
    const insertBuilder = makeInsertBuilder();
    const executeSpy = jest.spyOn(insertBuilder.builder as { execute: () => unknown }, 'execute');
    const { service } = makeService({ insertBuilder });

    const inserted = await service.upsertForSubjects(OWNER, [
      {
        subjectType: 'object_instance',
        subjectId: SUBJECT_A,
        identifiers: [{ namespace: 'gtin', value: '12345' }],
      },
    ]);

    expect(inserted).toBe(0);
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('collapses a claim shared by two subjects within the batch to the FIRST subject', async () => {
    const { service, insert } = makeService();

    await service.upsertForSubjects(OWNER, [
      // UPC-A form and its GTIN-14 zero-padded form of the SAME barcode —
      // both normalize to '00012345678905' (see normalizeObjectIdentifier.spec.ts).
      {
        subjectType: 'object_instance',
        subjectId: SUBJECT_A,
        identifiers: [{ namespace: 'gtin', value: '012345678905' }],
      },
      {
        subjectType: 'object_instance',
        subjectId: SUBJECT_B,
        identifiers: [{ namespace: 'gtin', value: '00012345678905' }],
      },
    ]);

    // Only ONE row reaches the INSERT — subject B's claim on an
    // already-claimed-in-this-batch value never becomes a write, matching the
    // documented first-writer-wins semantics (the loser is never inserted at
    // all, so it stays invisible to the claim index by design).
    expect(insert.calls.values).toHaveLength(1);
    expect((insert.calls.values[0] as { subjectId: string }).subjectId).toBe(SUBJECT_A);
  });

  it('scopes a brand-qualified namespace so the same serial from two brands does not collide', async () => {
    const { service, insert } = makeService();

    await service.upsertForSubjects(OWNER, [
      {
        subjectType: 'object_instance',
        subjectId: SUBJECT_A,
        identifiers: [{ namespace: 'serial', value: 'SN-0001', brand: 'Acme' }],
      },
      {
        subjectType: 'object_instance',
        subjectId: SUBJECT_B,
        identifiers: [{ namespace: 'serial', value: 'SN-0001', brand: 'Globex' }],
      },
    ]);

    expect(insert.calls.values).toHaveLength(2);
    const qualifiers = (insert.calls.values as Array<{ qualifier: string }>).map((r) => r.qualifier);
    expect(qualifiers.sort()).toEqual(['acme', 'globex']);
  });

  it('defaults confidence to 1.0 and isPrimary to false, but honors caller-supplied values', async () => {
    const { service, insert } = makeService();

    await service.upsertForSubjects(OWNER, [
      {
        subjectType: 'object_instance',
        subjectId: SUBJECT_A,
        identifiers: [{ namespace: 'sku', value: 'low-conf', confidence: 0.4, isPrimary: true }],
      },
    ]);

    expect(insert.calls.values).toEqual([expect.objectContaining({ confidence: 0.4, isPrimary: true })]);
  });

  it('chunks a batch larger than the derived param budget into bounded INSERTs', async () => {
    // columnsPerRow=20000 -> paramBudgetCap = floor(60000/20000) = 3 rows/chunk,
    // so 7 distinct claims split 3/3/1 without needing thousands of fixtures.
    const { service, insert } = makeService({ columnsPerRow: 20000 });

    const entries = Array.from({ length: 7 }, (_, i) => ({
      subjectType: 'object_instance' as const,
      subjectId: SUBJECT_A,
      identifiers: [{ namespace: 'serial' as const, value: `SN-${1000 + i}` }],
    }));

    const inserted = await service.upsertForSubjects(OWNER, entries);

    expect(insert.calls.valuesCalls.map((rows) => rows.length)).toEqual([3, 3, 1]);
    expect(insert.calls.orIgnore).toBe(3);
    expect(inserted).toBe(7);
  });

  it('still runs the remaining chunks when one fails, then rethrows summarizing the failure(s)', async () => {
    const insertBuilder = makeInsertBuilder();
    const execute = jest
      .fn()
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockImplementation(async () => ({ identifiers: [{}, {}, {}] }));
    insertBuilder.builder.execute = execute;
    const { service } = makeService({ insertBuilder, columnsPerRow: 20000 }); // 3 rows/chunk

    const entries = Array.from({ length: 6 }, (_, i) => ({
      subjectType: 'object_instance' as const,
      subjectId: SUBJECT_A,
      identifiers: [{ namespace: 'serial' as const, value: `SN-${2000 + i}` }],
    }));

    await expect(service.upsertForSubjects(OWNER, entries)).rejects.toThrow(
      /1 object-identifier insert chunk\(s\) failed \(3 rows inserted\).*deadlock detected/,
    );
    // Both chunks were attempted despite the first failing.
    expect(execute).toHaveBeenCalledTimes(2);
  });

  describe('when several chunks fail, the failure named is the one the import push must act on', () => {
    // The push tells "wait and resend" (not ready), "stop, never resend" (a
    // crash with the statement in flight) and "a refusal about the data" apart
    // from the error alone. Naming the FIRST failure let an early refusal hide
    // the crash a later chunk met, and the batch was degraded to per-row and
    // resent — into the same crash.
    const failing = (...failures: Error[]) => {
      const insertBuilder = makeInsertBuilder();
      const execute = jest.fn();

      for (const failure of failures) {
        execute.mockRejectedValueOnce(failure);
      }

      insertBuilder.builder.execute = execute;

      const { service } = makeService({ insertBuilder, columnsPerRow: 20000 }); // 3 rows/chunk
      const entries = Array.from({ length: failures.length * 3 }, (_, i) => ({
        subjectType: 'object_instance' as const,
        subjectId: SUBJECT_A,
        identifiers: [{ namespace: 'serial' as const, value: `SN-${3000 + i}` }],
      }));

      return service.upsertForSubjects(OWNER, entries).then(
        () => {
          throw new Error('expected upsertForSubjects to reject');
        },
        (err: unknown) => err as Error,
      );
    };

    const refusal = () => new Error('deadlock detected');
    const notReady = () => new Error('the database system is in recovery mode');
    const crash = () => new Error('Connection terminated unexpectedly');

    it('a crash in a later chunk is not hidden by a refusal in an earlier one', async () => {
      const failure = await failing(refusal(), crash());

      expect(classifyDatabaseError(failure)).toBe('crashed');
      expect(failure.message).toMatch(/2 object-identifier insert chunk\(s\) failed.*Connection terminated/);
    });

    it('a crash outranks a not-ready failure, which outranks a refusal', async () => {
      expect(classifyDatabaseError(await failing(refusal(), notReady()))).toBe('not_ready');
      expect(classifyDatabaseError(await failing(notReady(), crash(), refusal()))).toBe('crashed');
    });

    it('keeps the SQLSTATE of a crash whose wording says nothing about one', async () => {
      // 08006 (connection_failure) carries no phrase the message classifier
      // knows; only the code says the session ended under the statement.
      const failure = await failing(
        refusal(),
        Object.assign(new Error('connection failure'), { code: '08006' }),
      );

      expect(classifyDatabaseError(failure)).toBe('crashed');
    });

    it('leaves refusals alone: still no verdict, and the first refusal is what is named', async () => {
      const failure = await failing(new Error('deadlock detected'), new Error('value too long for type'));

      expect(classifyDatabaseError(failure)).toBeNull();
      expect(failure.message).toMatch(/2 object-identifier insert chunk\(s\) failed.*deadlock detected/);
    });
  });
});
