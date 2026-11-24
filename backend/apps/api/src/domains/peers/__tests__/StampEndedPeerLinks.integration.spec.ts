import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../__tests__/support/scratchDatabase';

/**
 * Links an edit left `status = 'revoked'` with `revoked_at` NULL (before #3062)
 * are stamped ended, so `peer_links_owner_handle_uniq` and `PeerLinkService`,
 * which both read `revoked_at`, agree that they are. Proved against real
 * Postgres: the index is the thing that has to agree.
 */
const MIGRATION = '20261030154500_stamp_ended_peer_links_revoked_at.sql';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../db/postgres/migrations');

/** One half of the migration, as dbmate would run it. */
function migrationSql(half: 'up' | 'down'): string {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8');
  const down = sql.indexOf('-- migrate:down');

  return half === 'up' ? sql.slice(0, down) : sql.slice(down);
}

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[peers/StampEndedPeerLinks.integration] SKIPPED: ${availability.reason}`);
}

jest.setTimeout(600_000);

const OWNER = '33333333-3333-4333-8333-333333333333';
const IDS = {
  /** Ended by an edit before #3062: status says so, revoked_at doesn't. */
  statusOnly: '01a00000-0000-7000-8000-000000000001',
  /** Ended properly. */
  ended: '01a00000-0000-7000-8000-000000000002',
  /** Live. */
  live: '01a00000-0000-7000-8000-000000000003',
};
const EDITED_AT = '2026-02-01T00:00:00.000Z';
const ENDED_AT = '2026-03-01T00:00:00.000Z';

describeWithDatabase(`stamp ended peer links (${availability.target})`, () => {
  let scratch: ScratchDatabase;

  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    scratch.dataSource.query(sql, params);

  async function link(id: string, handle: string, status: string, revokedAt: string | null): Promise<void> {
    await q(
      `INSERT INTO ci.peer_links (id, owner_user_id, peer_handle, memory_endpoint, status, updated_at, revoked_at)
       VALUES ($1, $2, $3, 'https://peer.test/agent/v1', $4, $5, $6)`,
      [id, OWNER, handle, status, EDITED_AT, revokedAt],
    );
  }

  /** Add the handle back as a live link, the row `PeerLinkService.upsert` inserts for a re-add. */
  async function addBack(handle: string): Promise<void> {
    await q(
      `INSERT INTO ci.peer_links (owner_user_id, peer_handle, memory_endpoint, status)
       VALUES ($1, $2, 'https://peer.test/agent/v1', 'active')`,
      [OWNER, handle],
    );
  }

  const rowOf = async (id: string) =>
    (
      await q<{ status: string; revoked_at: Date | null }>(
        'SELECT status, revoked_at FROM ci.peer_links WHERE id = $1',
        [id],
      )
    )[0];

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'stamp ended peer links' });
    await q(
      `INSERT INTO ci.users (id, name, email, password, onboarded)
       VALUES ($1, 'PeerStampOwner', 'peer.stamp@example.test', 'x', true)`,
      [OWNER],
    );
    await link(IDS.statusOnly, 'devon', 'revoked', null);
    await link(IDS.ended, 'ada', 'revoked', ENDED_AT);
    await link(IDS.live, 'bo', 'active', null);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('before the stamp, the index reads the status-only link as live, so the peer cannot be added back', async () => {
    await expect(addBack('devon')).rejects.toMatchObject({ constraint: 'peer_links_owner_handle_uniq' });
  });

  it('stamps that link ended at its last change, and leaves the others as they were', async () => {
    await q(migrationSql('up'));

    expect((await rowOf(IDS.statusOnly))?.revoked_at?.toISOString()).toBe(EDITED_AT);
    expect((await rowOf(IDS.ended))?.revoked_at?.toISOString()).toBe(ENDED_AT);
    expect(await rowOf(IDS.live)).toMatchObject({ status: 'active', revoked_at: null });
  });

  it('after it, the index agrees: the peer can be added back as a new link, and only once', async () => {
    await expect(addBack('devon')).resolves.toBeUndefined();
    await expect(addBack('devon')).rejects.toMatchObject({ constraint: 'peer_links_owner_handle_uniq' });

    const [{ live }] = await q<{ live: number }>(
      `SELECT count(*)::int AS live FROM ci.peer_links
        WHERE owner_user_id = $1 AND peer_handle = 'devon' AND revoked_at IS NULL`,
      [OWNER],
    );
    expect(live).toBe(1);
  });

  it('runs again without changing anything, and its rollback changes nothing', async () => {
    const before = await q('SELECT id, status, revoked_at FROM ci.peer_links ORDER BY id');

    await q(migrationSql('up'));
    await q(migrationSql('down'));

    expect(await q('SELECT id, status, revoked_at FROM ci.peer_links ORDER BY id')).toEqual(before);
  });
});
