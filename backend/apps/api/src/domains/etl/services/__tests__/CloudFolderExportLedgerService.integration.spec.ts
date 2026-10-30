import { randomUUID } from 'node:crypto';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../../__tests__/support/scratchDatabase';
import { CloudFolderExportLedgerService, FOLDER_SETTLE_MS } from '../CloudFolderExportLedgerService';

/**
 * The folder-export ledger against real Postgres. Every state change in it is
 * a conditional UPDATE — the WHERE clause is what stops two sync ticks both
 * downloading the same folder — and the driver answers `UPDATE … RETURNING`
 * as `[rows, rowCount]`, not rows. Neither is something a mock can check.
 *
 * Skips (loudly) when there is no administrative connection; see
 * `domains/__tests__/support/scratchDatabase.ts`.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[CloudFolderExportLedgerService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(600_000);

describeWithDatabase(`CloudFolderExportLedgerService, against real Postgres (${availability.target})`, () => {
  let scratch: ScratchDatabase;
  let ledger: CloudFolderExportLedgerService;

  const userId = randomUUID();
  const ctx = { userId };
  const ROOT = '/apps/meta/meta-2026-oct-05/facebook-user-abc';
  let key: { connectionId: string; provider: string };

  const age = (rootPath: string, column: 'last_change_at' | 'updated_at', ms: number) =>
    scratch.dataSource.query(
      `UPDATE ci_etl.cloud_folder_exports SET ${column} = now() - make_interval(secs => $3::float8 / 1000)
        WHERE connection_id = $1::uuid AND root_path = $2`,
      [key.connectionId, rootPath, ms],
    );

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'CloudFolderExportLedgerService.integration.spec' });
    await scratch.assertOwn();
    ledger = new CloudFolderExportLedgerService(scratch.dataSource);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(() => {
    // A fresh connection per test: rows never collide and nothing needs cleaning.
    key = { connectionId: randomUUID(), provider: 'dropbox' };
  });

  it('records a folder once, and merges importers on later sightings', async () => {
    await ledger.recordChange(ctx, { ...key, rootPath: ROOT, importers: ['facebook'] });
    await ledger.recordChange(ctx, { ...key, rootPath: ROOT, importers: ['facebook', 'instagram'] });

    const rows = await ledger.listForConnection(ctx, key);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rootPath: ROOT, status: 'collecting', attemptCount: 0 });
    expect([...rows[0].importers].sort()).toEqual(['facebook', 'instagram']);
  });

  it('does not claim a folder that changed recently', async () => {
    await ledger.recordChange(ctx, { ...key, rootPath: ROOT, importers: ['facebook'] });

    expect(await ledger.claimSettled(ctx, key)).toEqual([]);
  });

  it('claims a settled folder exactly once', async () => {
    await ledger.recordChange(ctx, { ...key, rootPath: ROOT, importers: ['facebook'] });
    await age(ROOT, 'last_change_at', FOLDER_SETTLE_MS + 60_000);

    const [first, second] = await Promise.all([ledger.claimSettled(ctx, key), ledger.claimSettled(ctx, key)]);

    expect(first.length + second.length).toBe(1);
    expect([...first, ...second][0]).toMatchObject({
      rootPath: ROOT,
      status: 'downloading',
      attemptCount: 1,
    });
  });

  it('reclaims a download whose heartbeat stopped, but not a live one', async () => {
    await ledger.recordChange(ctx, { ...key, rootPath: ROOT, importers: ['facebook'] });
    await age(ROOT, 'last_change_at', FOLDER_SETTLE_MS + 60_000);
    const [claimed] = await ledger.claimSettled(ctx, key);

    await ledger.heartbeat(claimed.id);
    expect(await ledger.claimSettled(ctx, key)).toEqual([]);

    await age(ROOT, 'updated_at', 60 * 60 * 1000);
    expect(await ledger.claimSettled(ctx, key)).toHaveLength(1);
  });

  it('marks a folder imported, and sends it round again when it changed mid-download', async () => {
    const quiet = '/apps/meta/quiet';
    const busy = '/apps/meta/busy';
    await ledger.recordChange(ctx, { ...key, rootPath: quiet, importers: ['facebook'] });
    await ledger.recordChange(ctx, { ...key, rootPath: busy, importers: ['facebook'] });
    await age(quiet, 'last_change_at', FOLDER_SETTLE_MS + 60_000);
    await age(busy, 'last_change_at', FOLDER_SETTLE_MS + 60_000);

    const claimedAt = new Date();
    const claimed = await ledger.claimSettled(ctx, key);
    expect(claimed).toHaveLength(2);

    // A sync sees a new file in `busy` while its download is running.
    await ledger.recordChange(ctx, { ...key, rootPath: busy, importers: ['facebook'] });

    for (const folder of claimed) {
      await ledger.markImported(folder.id, {
        claimedAt,
        fileCount: 3,
        byteSize: 5_000_000_000,
        dropId: randomUUID(),
        importRunId: randomUUID(),
      });
    }

    const byRoot = new Map((await ledger.listForConnection(ctx, key)).map((row) => [row.rootPath, row]));

    expect(byRoot.get(quiet)).toMatchObject({ status: 'imported', fileCount: 3, byteSize: 5_000_000_000 });
    expect(byRoot.get(busy)).toMatchObject({ status: 'collecting' });
  });

  it('reopens an imported folder when the provider writes more into it', async () => {
    await ledger.recordChange(ctx, { ...key, rootPath: ROOT, importers: ['facebook'] });
    await age(ROOT, 'last_change_at', FOLDER_SETTLE_MS + 60_000);
    const [claimed] = await ledger.claimSettled(ctx, key);
    await ledger.markImported(claimed.id, {
      claimedAt: new Date(),
      fileCount: 1,
      byteSize: 1,
      dropId: randomUUID(),
      importRunId: randomUUID(),
    });

    await ledger.recordChange(ctx, { ...key, rootPath: ROOT, importers: ['facebook'] });

    expect((await ledger.listForConnection(ctx, key))[0].status).toBe('collecting');
  });

  it('parks a settled folder that has nothing to read yet for another settle window', async () => {
    await ledger.recordChange(ctx, { ...key, rootPath: ROOT, importers: ['facebook'] });
    await age(ROOT, 'last_change_at', FOLDER_SETTLE_MS + 60_000);
    const [claimed] = await ledger.claimSettled(ctx, key);

    await ledger.markWaiting(claimed.id, { fileCount: 5834, reason: 'waiting: nothing to read yet' });

    expect((await ledger.listForConnection(ctx, key))[0]).toMatchObject({
      status: 'collecting',
      fileCount: 5834,
      lastError: 'waiting: nothing to read yet',
    });
    // Not looked at again on the very next tick…
    expect(await ledger.claimSettled(ctx, key)).toEqual([]);
    // …but again once a settle window has passed with no change.
    await age(ROOT, 'last_change_at', FOLDER_SETTLE_MS + 60_000);
    expect(await ledger.claimSettled(ctx, key)).toHaveLength(1);
  });

  it('returns a failed download to the queue with its reason', async () => {
    await ledger.recordChange(ctx, { ...key, rootPath: ROOT, importers: ['facebook'] });
    await age(ROOT, 'last_change_at', FOLDER_SETTLE_MS + 60_000);
    const [claimed] = await ledger.claimSettled(ctx, key);

    await ledger.markFailed(claimed.id, 'Dropbox download of a.jpg failed: 401 Unauthorized');

    expect((await ledger.listForConnection(ctx, key))[0]).toMatchObject({
      status: 'collecting',
      lastError: 'Dropbox download of a.jpg failed: 401 Unauthorized',
    });
    // Still settled, so the very next tick tries again.
    expect(await ledger.claimSettled(ctx, key)).toHaveLength(1);
  });
});
