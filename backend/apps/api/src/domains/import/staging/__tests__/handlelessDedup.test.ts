import { StagedWriter } from '../StagedWriter';

/**
 * Handle-less entities must dedup in the DATABASE, not in process memory.
 *
 * A StagedWriter is constructed per parse ATTEMPT. When the dedup lived in an
 * instance `Map`, a crash mid-parse and the staleness sweep's resume began with
 * an empty map and re-inserted everything the dead attempt had written.
 * Measured on a 20k-vCard run killed with SIGKILL: items collapsed correctly
 * (20,001 / 20,001 distinct) and identity-keyed entities too (10,000 / 10,000),
 * but handle-less entities came back 12,000 rows for 10,000 distinct
 * (type, name), with 2,000 spurious edges alongside.
 */

const SCOPE = {
  userId: '33333333-3333-4333-8333-333333333333',
  runId: '11111111-1111-4111-8111-111111111111',
  dataSource: 'vcard',
};

interface InsertRow {
  identity_key: string | null;
  dedupe_key: string | null;
}

/**
 * A manager standing in for Postgres with the partial unique index in place:
 * a row carrying a dedupe_key already present in this run is left out of what
 * the set-based INSERT returns, exactly as `ON CONFLICT ... DO NOTHING
 * RETURNING` does. The writer sends each statement's rows as ONE jsonb
 * parameter (`jsonb_to_recordset`), so the stand-in reads them back from it.
 */
function managerWithUniqueIndex(existing: Map<string, string>) {
  const inserts: string[] = [];

  const query = jest.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('INSERT INTO ci_import.staged_entities')) {
      const rows = JSON.parse(params[0] as string) as InsertRow[];
      const returned: Array<{ id: string; identity_key?: string; dedupe_key?: string }> = [];

      for (const row of rows) {
        if (row.dedupe_key == null) {
          returned.push({ id: `entity-${existing.size + 1}`, identity_key: row.identity_key ?? undefined });
          continue;
        }

        if (existing.has(row.dedupe_key)) {
          continue;
        }

        const id = `entity-${existing.size + 1}`;
        existing.set(row.dedupe_key, id);
        inserts.push(row.dedupe_key);
        returned.push({ id, dedupe_key: row.dedupe_key });
      }

      return returned;
    }

    // The read-back of rows an earlier attempt wrote, by dedupe key.
    if (sql.includes('SELECT id, metadata, accumulate, dedupe_key')) {
      const keys = params[1] as string[];

      return keys.flatMap((key) => {
        const id = existing.get(key);

        return id ? [{ id, metadata: {}, accumulate: null, dedupe_key: key }] : [];
      });
    }

    // The read-back of rows this attempt's cache already knows, by id.
    if (sql.includes('WHERE id = ANY($1::uuid[])')) {
      return (params[0] as string[]).map((id) => ({ id, metadata: {}, accumulate: null }));
    }

    return [];
  });

  const manager = {
    query,
    transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ query })),
  };

  return { manager, inserts };
}

function personGraph(name: string) {
  // No handle of any kind — the population that takes the handle-less path.
  return { entity: { name, type: 'person', attributes: [] } } as never;
}

describe('handle-less staged entity dedup', () => {
  it('does not re-insert what an earlier attempt already wrote', async () => {
    // One shared "database" across two writers = a crash and its resume.
    const store = new Map<string, string>();

    const first = managerWithUniqueIndex(store);
    const attemptOne = new StagedWriter(first.manager as never, SCOPE, 1);
    attemptOne.push(personGraph('Kill Person 1131'));
    await attemptOne.settled();

    expect(first.inserts).toHaveLength(1);

    // The worker dies here. The sweep re-queues the stage, and ParseStage builds
    // a NEW StagedWriter — empty map, same run, replaying the same records.
    const second = managerWithUniqueIndex(store);
    const attemptTwo = new StagedWriter(second.manager as never, SCOPE, 1);
    attemptTwo.push(personGraph('Kill Person 1131'));
    await attemptTwo.settled();

    expect(second.inserts).toHaveLength(0);
    expect(store.size).toBe(1);
  });

  it('still collapses repeat sightings within one attempt', async () => {
    const store = new Map<string, string>();
    const { manager, inserts } = managerWithUniqueIndex(store);
    const writer = new StagedWriter(manager as never, SCOPE, 1);

    writer.push(personGraph('Ada Lovelace'));
    writer.push(personGraph('Ada Lovelace'));
    await writer.settled();

    expect(inserts).toHaveLength(1);
  });

  it('collapses repeat sightings within one BATCH before the statement is sent', async () => {
    // Threshold 2: both sightings land in one flush, so the collapse has to
    // happen in memory — the INSERT must carry one row, not two that would
    // conflict with each other inside the statement.
    const store = new Map<string, string>();
    const { manager, inserts } = managerWithUniqueIndex(store);
    const writer = new StagedWriter(manager as never, SCOPE, 2);

    writer.push(personGraph('Ada Lovelace'));
    writer.push(personGraph('Ada Lovelace'));
    await writer.settled();

    const insertCalls = (manager.query as jest.Mock).mock.calls.filter(([sql]) =>
      (sql as string).includes('INSERT INTO ci_import.staged_entities'),
    );

    expect(insertCalls).toHaveLength(1);
    expect(JSON.parse(insertCalls[0][1][0] as string)).toHaveLength(1);
    expect(inserts).toHaveLength(1);
  });

  it('keeps genuinely different entities apart', async () => {
    const store = new Map<string, string>();
    const { manager, inserts } = managerWithUniqueIndex(store);
    const writer = new StagedWriter(manager as never, SCOPE, 1);

    writer.push(personGraph('Ada Lovelace'));
    writer.push(personGraph('Grace Hopper'));
    await writer.settled();

    expect(inserts).toHaveLength(2);
  });
});
