import type { EntityManager } from 'typeorm';

import { appendRecordSources, type RecordSourceRow } from '../recordSources';

const USER = '00000000-0000-0000-0000-0000000000aa';
const RECORD = '00000000-0000-0000-0000-0000000000b1';

interface LedgerRow {
  user_id: string;
  record_table: string;
  source_type: string;
  source_system: string;
  source_id: string;
  platform: string | null;
}

/**
 * Fake EntityManager backing ci.record_sources with an in-memory table that
 * enforces the same arbiter as the real
 * record_sources_identity_uniq index (user_id, record_table, source_type,
 * source_system, source_id, platform) NULLS NOT DISTINCT, so a conflicting
 * INSERT is silently skipped exactly like ON CONFLICT DO NOTHING against
 * Postgres would do.
 */
function makeManager() {
  const rows: LedgerRow[] = [];

  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    if (!sql.includes('INSERT INTO ci.record_sources')) {
      return [];
    }

    const [userId, table, recordIds, sourceTypes, sourceSystems, sourceIds, , , platforms] = params as [
      string,
      string,
      string[],
      string[],
      string[],
      string[],
      Array<string | null>,
      Array<string | null>,
      Array<string | null>,
    ];

    for (let i = 0; i < recordIds.length; i++) {
      const candidate: LedgerRow = {
        user_id: userId,
        record_table: table,
        source_type: sourceTypes[i],
        source_system: sourceSystems[i],
        source_id: sourceIds[i],
        platform: platforms[i],
      };

      const conflicts = rows.some(
        (row) =>
          row.user_id === candidate.user_id &&
          row.record_table === candidate.record_table &&
          row.source_type === candidate.source_type &&
          row.source_system === candidate.source_system &&
          row.source_id === candidate.source_id &&
          row.platform === candidate.platform,
      );

      if (!conflicts) {
        rows.push(candidate);
      }
    }

    return [];
  });

  return { query, rows } as unknown as EntityManager & { rows: LedgerRow[] };
}

describe('appendRecordSources', () => {
  it('keeps both rows when the same datum arrives from two platforms under one federated source_system', async () => {
    // Regression for the bug where `platform` sat outside the conflict key: a
    // Gmail fetch and a Microsoft-account fetch of the same message both
    // ledger under source_system 'email', and used to collapse onto one row.
    const manager = makeManager();
    const scope = { table: 'communications', userId: USER };
    const base: Omit<RecordSourceRow, 'platform'> = {
      recordId: RECORD,
      sourceType: 'ci-import-tools',
      sourceSystem: 'email',
      sourceId: 'm@x',
    };

    await appendRecordSources(manager, scope, [{ ...base, platform: 'gmail' }]);
    await appendRecordSources(manager, scope, [{ ...base, platform: 'microsoft_account' }]);

    expect(manager.rows).toHaveLength(2);
    expect(manager.rows.map((row) => row.platform).sort()).toEqual(['gmail', 'microsoft_account']);
  });

  it('does not collapse two platforms arriving in the same call (in-memory dedup mirrors the DB arbiter)', async () => {
    const manager = makeManager();
    const scope = { table: 'communications', userId: USER };
    const base: Omit<RecordSourceRow, 'platform'> = {
      recordId: RECORD,
      sourceType: 'ci-import-tools',
      sourceSystem: 'email',
      sourceId: 'm@x',
    };

    await appendRecordSources(manager, scope, [
      { ...base, platform: 'gmail' },
      { ...base, platform: 'microsoft_account' },
    ]);

    expect(manager.rows).toHaveLength(2);
  });

  it('still collapses a true re-ingest (same platform) to one row', async () => {
    const manager = makeManager();
    const scope = { table: 'communications', userId: USER };
    const row: RecordSourceRow = {
      recordId: RECORD,
      sourceType: 'ci-import-tools',
      sourceSystem: 'email',
      sourceId: 'm@x',
      platform: 'gmail',
    };

    await appendRecordSources(manager, scope, [row]);
    await appendRecordSources(manager, scope, [row]);

    expect(manager.rows).toHaveLength(1);
  });

  it('still collapses two arrivals whose platform is unknown (NULL) on both sides', async () => {
    // platform: null (producer could not say) must keep pairing with itself,
    // not fan out into duplicate rows for the same generic mbox/.ics import.
    const manager = makeManager();
    const scope = { table: 'communications', userId: USER };
    const row: RecordSourceRow = {
      recordId: RECORD,
      sourceType: 'ci-import-tools',
      sourceSystem: 'email',
      sourceId: 'm@x',
      platform: null,
    };

    await appendRecordSources(manager, scope, [row]);
    await appendRecordSources(manager, scope, [row]);

    expect(manager.rows).toHaveLength(1);
    expect(manager.rows[0].platform).toBeNull();
  });

  it('defaults an omitted platform to the source_system (platform-kind shorthand)', async () => {
    const manager = makeManager();
    const scope = { table: 'communications', userId: USER };

    await appendRecordSources(manager, scope, [
      { recordId: RECORD, sourceType: 'connection', sourceSystem: 'gmail', sourceId: 'm@x' },
    ]);

    expect(manager.rows).toHaveLength(1);
    expect(manager.rows[0].platform).toBe('gmail');
  });
});
