import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import {
  BaseEntity,
  ContentBaseEntity,
  ContentEntity,
  ContentService,
  EventBaseEntity,
  EventEntity,
  GraphDeltaWriter,
} from '@ci/domains/memory';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../__tests__/support/applianceUser';
import { dataSourceConnection } from '../../__tests__/support/databaseConnection';
import { MediaStage } from '../stages/MediaStage';

import {
  createStagingHarness,
  IMPORT_DATABASE_ENV,
  importDatabase,
  type StagingHarness,
} from './support/stagingHarness';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A MESSENGER ATTACHMENT STILL UNDER `facebook` CONVERGES ON RE-IMPORT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * #2912 keys a Messenger attachment's content row under `facebook_messenger`
 * with the same source_id it had under `facebook`. Migration 20261002005332
 * moves the rows present when it runs; one can still come back under the old
 * key afterwards (a portability archive exported before it carries no schema
 * version, so no migration reaches its rows). A re-import then has to land on
 * that row, not beside it, because `content_source_identity_uniq` is
 * `(user_id, source_system, source_id)` and the insert alone cannot see it.
 *
 * The first half runs the REAL MediaStage attachment pass against a real
 * ContentService over a staged Messenger message, with only the object store
 * faked, and includes the control that proves the move is what prevents the
 * twin. The second half pins `ContentService.rekeySourceSystem`'s edges.
 *
 * Opt-in like its neighbours: set `IMPORT_TEST_DATABASE_URL` to a migrated
 * database of your OWN, or run `make test-db`, which provides one.
 *
 * Invented throughout: ids, hashes, names.
 */

const describeWithDb = importDatabase.available ? describe : describe.skip;

if (!importDatabase.available) {
  console.warn(`[import/messengerAttachmentRekey.integration] SKIPPED — ${importDatabase.reason}`);
}

jest.setTimeout(120_000);

const SHA = 'c0ffee'.padEnd(64, '0');
/** Older than anything a write here could stamp, so a bump is visible. */
const SEEDED_AT = new Date('2026-01-01T00:00:00Z');

const logger = () =>
  ({
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

describeWithDb(`a Messenger attachment catalogued before #2912 (${importDatabase.target})`, () => {
  let harness: StagingHarness;
  let teardown: () => Promise<void>;
  let memory: DataSource;
  let contents: ContentService;
  let strangerId: string;
  let scratchDir: string;

  beforeAll(async () => {
    ({ harness, teardown } = await createStagingHarness());

    memory = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(IMPORT_DATABASE_ENV),
      entities: [BaseEntity, UserEntity, ContentBaseEntity, ContentEntity, EventBaseEntity, EventEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public', max: 4 },
    });
    await memory.initialize();

    contents = new ContentService(
      memory.getRepository(ContentEntity),
      memory.getRepository(ContentBaseEntity),
      memory.getRepository(EventEntity),
      { send: jest.fn(async () => []) } as unknown as EventService,
      new GraphDeltaWriter(memory, logger()),
    );
    strangerId = await createSyntheticTestUser(
      (sql, params) => memory.query(sql, params),
      'MessengerRekeyStranger',
    );
  });

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-rekey-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    fs.rmSync(scratchDir, { recursive: true, force: true });

    const users = [harness.userId, strangerId];

    await memory.query(`DELETE FROM ci.record_sources WHERE user_id = ANY($1::uuid[])`, [users]);
    await memory.query(`DELETE FROM ci.graph_deltas WHERE owner_user_id = ANY($1::uuid[])`, [users]);
    await memory.query(
      `DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[]) AND entity_type = 'Content'`,
      [users],
    );
  });

  afterAll(async () => {
    if (memory?.isInitialized) {
      await memory.query(`DELETE FROM ci.users WHERE id = $1`, [strangerId]);
      await memory.destroy();
    }

    await teardown?.();
  });

  // ── Fixtures ──────────────────────────────────────────────────────────────

  /** A Messenger message id, as facebook.ts mints it. */
  const messageHash = (label: string) =>
    `facebook:msg:v2:${Buffer.from(label).toString('hex').padEnd(40, '0').slice(0, 40)}`;

  /** The id MediaStage keys a Messenger attachment on: the message's, plus the bytes' hash. */
  const attachmentKey = (label: string) => `attachment:${messageHash(label)}:${SHA}`;

  /** A content row over a stored attachment, and the ledger row its insert appended. */
  async function contentRow(seed: {
    system: string;
    sourceId: string;
    fileId: string;
    forUser?: string;
    ledger?: Array<{
      system: string;
      sourceId?: string;
      platform?: string | null;
      recordId?: string;
      importRunId?: string;
    }>;
  }): Promise<string> {
    const contentId = randomUUID();
    const forUser = seed.forUser ?? harness.userId;

    await memory.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Content', 'photo.jpg', '{}'::jsonb, $2, 'content', $1)`,
      [contentId, forUser],
    );
    await memory.query(
      `INSERT INTO ci.content
         (id, type, mimetype, external_id, external_id_kind, user_id,
          source_type, source_system, source_id, created_at, updated_at)
       VALUES ($1, 'media', 'image/jpeg', $2, 'file', $3, 'ci-import-tools', $4, $5, $6, $6)`,
      [contentId, seed.fileId, forUser, seed.system, seed.sourceId, SEEDED_AT],
    );

    for (const entry of seed.ledger ?? [{ system: seed.system }]) {
      await memory.query(
        `INSERT INTO ci.record_sources
           (user_id, record_table, record_id, source_type, source_system, source_id, platform, import_run_id)
         VALUES ($1, 'content', $2, 'ci-import-tools', $3, $4, $5, $6)`,
        [
          forUser,
          entry.recordId ?? contentId,
          entry.system,
          entry.sourceId ?? seed.sourceId,
          entry.platform === undefined ? entry.system : entry.platform,
          entry.importRunId ?? null,
        ],
      );
    }

    return contentId;
  }

  /** Every content row of the harness user under this source_id, and its ledger. */
  async function rowsFor(sourceId: string): Promise<
    Array<{
      id: string;
      source_system: string;
      updated_at: Date;
      ledger: Array<{ source_system: string; source_id: string; platform: string | null }>;
    }>
  > {
    return memory.query(
      `SELECT c.id, c.source_system, c.updated_at,
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                 'source_system', rs.source_system,
                                 'source_id', rs.source_id,
                                 'platform', rs.platform)
                               ORDER BY rs.source_system, rs.source_id)
                          FROM ci.record_sources rs
                         WHERE rs.record_table = 'content' AND rs.record_id = c.id), '[]'::jsonb) AS ledger
         FROM ci.content c
        WHERE c.user_id = $1 AND c.source_id = $2
        ORDER BY c.source_system`,
      [harness.userId, sourceId],
    );
  }

  /**
   * Stage one Messenger message carrying one photo, the way facebook.ts stages
   * it, run the media stage over it, and return what the pass stamped on the row.
   */
  async function reimport(label: string, fileId: string): Promise<{ contentIds: string[] }> {
    const runId = await harness.startRun();
    const photo = path.join(scratchDir, `${label}.jpg`);

    fs.writeFileSync(photo, `bytes of ${label}`);

    const [{ id: stagedId }] = await harness.dataSource.query<Array<{ id: string }>>(
      `INSERT INTO ci_import.staged_items (run_id, user_id, data_source, classification, content_hash, metadata)
       VALUES ($1, $2, 'facebook', 'message', $3, $4::jsonb)
       RETURNING id`,
      [
        runId,
        harness.userId,
        messageHash(label),
        JSON.stringify({ Source: 'Facebook', MediaFilePaths: [photo], AttachmentContent: true }),
      ],
    );

    // The object store already holds these bytes: same hash, same file.
    const files = {
      uploadWithDedupInfo: jest.fn(async () => ({ file: { id: fileId, hash: SHA }, deduped: true })),
    };
    const stage = new MediaStage(harness.dataSource, files as never, contents, logger());

    await stage.run({
      userId: harness.userId,
      runId,
      stageId: randomUUID(),
      scratchDir,
      progress: async () => undefined,
    });

    const [{ metadata }] = await harness.dataSource.query<Array<{ metadata: Record<string, unknown> }>>(
      `SELECT metadata FROM ci_import.staged_items WHERE id = $1`,
      [stagedId],
    );

    return { contentIds: (metadata.AttachmentContentIds as string[] | undefined) ?? [] };
  }

  // ── The stage ─────────────────────────────────────────────────────────────

  describe('re-imported through the media stage', () => {
    it('lands on the row under the old key, moved in place, instead of beside it', async () => {
      const fileId = randomUUID();
      const legacyId = await contentRow({ system: 'facebook', sourceId: attachmentKey('restored'), fileId });

      const { contentIds } = await reimport('restored', fileId);

      expect(contentIds).toEqual([legacyId]);
      expect(await rowsFor(attachmentKey('restored'))).toEqual([
        {
          id: legacyId,
          source_system: 'facebook_messenger',
          // A corrected label is not a content change: the explorer browses by this.
          updated_at: SEEDED_AT,
          ledger: [
            {
              source_system: 'facebook_messenger',
              source_id: attachmentKey('restored'),
              platform: 'facebook_messenger',
            },
          ],
        },
      ]);
    });

    it('writes the twin without the move, which is what the move is for', async () => {
      // The control: the same run with the move switched off reproduces what was
      // measured on the reference corpus, a second row over the same file that
      // the message's `attachments` never names.
      jest.spyOn(contents, 'rekeySourceSystem').mockResolvedValue([]);

      const fileId = randomUUID();
      const legacyId = await contentRow({ system: 'facebook', sourceId: attachmentKey('control'), fileId });

      const { contentIds } = await reimport('control', fileId);
      const rows = await rowsFor(attachmentKey('control'));

      expect(rows.map((row) => row.source_system)).toEqual(['facebook', 'facebook_messenger']);
      expect(rows[0].id).toBe(legacyId);
      expect(contentIds).toEqual([rows[1].id]);
    });

    it('leaves a twin that already exists alone, and lands on the new row', async () => {
      const fileId = randomUUID();
      const legacyId = await contentRow({ system: 'facebook', sourceId: attachmentKey('twin'), fileId });
      const newId = await contentRow({
        system: 'facebook_messenger',
        sourceId: attachmentKey('twin'),
        fileId,
      });

      const { contentIds } = await reimport('twin', fileId);

      expect(contentIds).toEqual([newId]);
      expect((await rowsFor(attachmentKey('twin'))).map((row) => [row.id, row.source_system])).toEqual([
        [legacyId, 'facebook'],
        [newId, 'facebook_messenger'],
      ]);
    });

    it('catalogues a first import under facebook_messenger, as #2912 does', async () => {
      const { contentIds } = await reimport('fresh', randomUUID());
      const rows = await rowsFor(attachmentKey('fresh'));

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: contentIds[0],
        source_system: 'facebook_messenger',
        ledger: [{ source_system: 'facebook_messenger', platform: 'facebook_messenger' }],
      });
    });
  });

  // ── The move ──────────────────────────────────────────────────────────────

  describe('ContentService.rekeySourceSystem', () => {
    const move = (sourceIds: string[]) => ({ from: 'facebook', to: 'facebook_messenger', sourceIds });

    it("moves only the caller's own rows", async () => {
      const fileId = randomUUID();
      const strangers = await contentRow({
        system: 'facebook',
        sourceId: attachmentKey('shared'),
        fileId,
        forUser: strangerId,
      });

      expect(
        await contents.rekeySourceSystem({ userId: harness.userId }, move([attachmentKey('shared')])),
      ).toEqual([]);

      const [row] = await memory.query(`SELECT source_system FROM ci.content WHERE id = $1`, [strangers]);

      expect(row).toEqual({ source_system: 'facebook' });
    });

    it('clears a ledger row left under the new key by a record that is gone, instead of colliding', async () => {
      const legacyId = await contentRow({
        system: 'facebook',
        sourceId: attachmentKey('dangling'),
        fileId: randomUUID(),
        ledger: [
          { system: 'facebook' },
          // A twin removed through the app's delete, which leaves ledger rows behind.
          { system: 'facebook_messenger', recordId: randomUUID() },
        ],
      });

      expect(
        await contents.rekeySourceSystem({ userId: harness.userId }, move([attachmentKey('dangling')])),
      ).toEqual([legacyId]);

      const ledger = await memory.query(
        `SELECT record_id, source_system, platform FROM ci.record_sources WHERE user_id = $1 AND source_id = $2`,
        [harness.userId, attachmentKey('dangling')],
      );

      expect(ledger).toEqual([
        { record_id: legacyId, source_system: 'facebook_messenger', platform: 'facebook_messenger' },
      ]);
    });

    it('drops an old-key arrival whose new key the row already holds, and keeps that one', async () => {
      // The arrival already under the new key keeps its run: undo-import and
      // disconnect key on a ledger row's run and connection.
      const heldRun = randomUUID();
      const legacyId = await contentRow({
        system: 'facebook',
        sourceId: attachmentKey('held'),
        fileId: randomUUID(),
        ledger: [{ system: 'facebook' }, { system: 'facebook_messenger', importRunId: heldRun }],
      });

      await contents.rekeySourceSystem({ userId: harness.userId }, move([attachmentKey('held')]));

      expect((await rowsFor(attachmentKey('held')))[0]).toMatchObject({
        id: legacyId,
        source_system: 'facebook_messenger',
        ledger: [{ source_system: 'facebook_messenger', platform: 'facebook_messenger' }],
      });
      expect(
        await memory.query(
          `SELECT import_run_id FROM ci.record_sources WHERE record_table = 'content' AND record_id = $1`,
          [legacyId],
        ),
      ).toEqual([{ import_run_id: heldRun }]);
    });

    it('moves what it can when another row in the same call already has its twin', async () => {
      // One message, two attachments: one was re-imported after upgrading (a
      // twin), the other was not. The twin must not stop the other one moving.
      const fileId = randomUUID();
      const twinned = await contentRow({ system: 'facebook', sourceId: attachmentKey('mixed-twin'), fileId });

      await contentRow({ system: 'facebook_messenger', sourceId: attachmentKey('mixed-twin'), fileId });

      const plain = await contentRow({ system: 'facebook', sourceId: attachmentKey('mixed-plain'), fileId });

      expect(
        await contents.rekeySourceSystem(
          { userId: harness.userId },
          move([attachmentKey('mixed-twin'), attachmentKey('mixed-plain')]),
        ),
      ).toEqual([plain]);
      expect((await rowsFor(attachmentKey('mixed-twin'))).map((row) => [row.id, row.source_system])).toEqual([
        [twinned, 'facebook'],
        [expect.any(String), 'facebook_messenger'],
      ]);
      expect((await rowsFor(attachmentKey('mixed-plain')))[0]).toMatchObject({
        id: plain,
        source_system: 'facebook_messenger',
      });
    });

    it('leaves a ledger row that recorded some other identity of the row alone', async () => {
      const legacyId = await contentRow({
        system: 'facebook',
        sourceId: attachmentKey('other'),
        fileId: randomUUID(),
        ledger: [{ system: 'facebook' }, { system: 'facebook', sourceId: 'facebook:photo:10150' }],
      });

      await contents.rekeySourceSystem({ userId: harness.userId }, move([attachmentKey('other')]));

      expect((await rowsFor(attachmentKey('other')))[0]).toMatchObject({
        id: legacyId,
        ledger: [
          { source_system: 'facebook', source_id: 'facebook:photo:10150', platform: 'facebook' },
          {
            source_system: 'facebook_messenger',
            source_id: attachmentKey('other'),
            platform: 'facebook_messenger',
          },
        ],
      });
    });
  });
});
