import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ConflictException } from '@nestjs/common';

import { syntheticTestUserEmail } from '../../__tests__/support/applianceUser';
import { UnpackStage } from '../stages/UnpackStage';

import {
  createStagingHarness,
  importDatabase,
  removeSyntheticUserInbox,
  type StagingHarness,
} from './support/stagingHarness';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE INBOX FOLDER, MANY ACCOUNTS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `staged_sources_active_path_uq` was `(user_id, source_path)` — the obviously
 * correct scoping, and wrong for what it guards. The inbox is a single folder
 * on the appliance; two accounts looking at it see the same archives because
 * there is only one of each. Keying the claim by user therefore let both of
 * them claim one unit at the same moment, and the unpack acquires BY RENAME:
 * the first run to reach the move imported the other person's export into its
 * own account, and the second failed over bytes that were no longer there.
 *
 * The index is the fix, so the index is what this spec exercises — against real
 * Postgres, because a mocked repository cannot have a unique index.
 */

const describeWithDatabase = importDatabase.available ? describe : describe.skip;

if (!importDatabase.available) {
  console.warn(`[import/inboxTenancy.integration] SKIPPED — ${importDatabase.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`inbox tenancy (${importDatabase.target})`, () => {
  let harness: StagingHarness;
  let teardown: () => Promise<void>;
  let inbox: string;
  let otherUserId: string;
  let otherEmail: string;
  const otherRuns: string[] = [];

  beforeAll(async () => {
    ({ harness, teardown } = await createStagingHarness());
    inbox = await mkdtemp(path.join(os.tmpdir(), 'ci-inbox-tenancy-'));

    // A SECOND real account on the same appliance. Nothing about this is
    // exotic — it is what "multi-user" means — and it is the configuration the
    // per-user claim silently mishandled.
    otherUserId = randomUUID();
    otherEmail = syntheticTestUserEmail('inbox-tenancy-other', otherUserId);
    await harness.dataSource.query(
      `INSERT INTO ci.users (id, name, email) VALUES ($1::uuid, 'inbox tenancy other', $2)
       ON CONFLICT (id) DO NOTHING`,
      [otherUserId, otherEmail],
    );
  });

  afterAll(async () => {
    for (const runId of otherRuns) {
      await harness.dataSource.query(`DELETE FROM ci_import.import_runs WHERE id = $1::uuid`, [runId]);
    }

    await harness.dataSource.query(`DELETE FROM ci_import.staged_sources WHERE user_id = $1::uuid`, [
      otherUserId,
    ]);
    await harness.dataSource.query(`DELETE FROM ci.users WHERE id = $1::uuid`, [otherUserId]);
    // A running server scaffolds a REAL inbox folder for every ci.users row;
    // deleting the row leaves it behind (see removeSyntheticUserInbox).
    await removeSyntheticUserInbox(otherUserId, otherEmail);

    await teardown();
  });

  async function seedUnit(name: string): Promise<string> {
    const unit = path.join(inbox, name);

    await mkdir(unit, { recursive: true });
    await writeFile(path.join(unit, 'note.txt'), 'bytes');

    return unit;
  }

  it('refuses a second account claiming the same inbox path', async () => {
    const unit = await seedUnit('shared-takeout');

    const mine = await harness.service.startRun(
      { userId: harness.userId },
      { localSource: { path: unit, kind: 'directory', sizeBytes: 5 }, source: 'api' },
    );

    // Registered for the harness's own cleanup by starting through it would be
    // nicer, but the local-source path has no drop; track it here instead.
    otherRuns.push(mine.run.id);

    await expect(
      harness.service.startRun(
        { userId: otherUserId },
        { localSource: { path: unit, kind: 'directory', sizeBytes: 5 }, source: 'api' },
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const rows = await harness.dataSource.query<Array<{ user_id: string }>>(
      `SELECT user_id FROM ci_import.staged_sources
        WHERE source_path = $1 AND status IN ('claimed', 'moved')`,
      [unit],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(harness.userId);
  });

  it('does not hand one account the source another account claimed', async () => {
    const unit = await seedUnit('someone-elses');

    const theirs = await harness.service.startRun(
      { userId: otherUserId },
      { localSource: { path: unit, kind: 'directory', sizeBytes: 5 }, source: 'api' },
    );

    otherRuns.push(theirs.run.id);

    // The stage's payload carries the user; the registry lookup is scoped by
    // it, so a job that named the wrong one finds nothing to move rather than
    // renaming somebody else's archive into this run's scratch tree.
    expect(await harness.stagedSources.findByRunId(harness.userId, theirs.run.id)).toBeNull();
    expect(await harness.stagedSources.findByRunId(otherUserId, theirs.run.id)).not.toBeNull();

    const stage = new UnpackStage(harness.dataSource, harness.stagedSources, {
      setContext: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    } as never);

    await expect(
      stage.run({
        userId: harness.userId,
        runId: theirs.run.id,
        stageId: theirs.stages[0].id,
        scratchDir: await mkdtemp(path.join(os.tmpdir(), 'ci-inbox-tenancy-scratch-')),
        progress: async () => undefined,
      }),
    ).rejects.toThrow(/no claimed source/);
  });

  it('reports every live claim on a path, whoever holds it', async () => {
    const unit = await seedUnit('visible-to-both');

    const theirs = await harness.service.startRun(
      { userId: otherUserId },
      { localSource: { path: unit, kind: 'directory', sizeBytes: 5 }, source: 'api' },
    );

    otherRuns.push(theirs.run.id);

    const active = await harness.stagedSources.findActiveByPaths([unit]);

    expect(active).toHaveLength(1);
    expect(active[0].userId).toBe(otherUserId);
  });
});
