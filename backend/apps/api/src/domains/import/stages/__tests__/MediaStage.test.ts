import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { StageRunContext } from '../../types';
import { MediaStage } from '../MediaStage';

/**
 * What matters here is the ledger, not the upload: this stage exists because
 * the bytes were being deleted with the scratch tree while the rows that
 * describe them claimed success, so the assertions are about a row ending up
 * pointing at a stored file — or, when it cannot, saying so once and not
 * spinning on it.
 *
 * The attachment pass is held to the SAME bar, and to one more: a descriptor it
 * declines has to be counted. A green `dropped: 0` over 566 files nobody
 * uploaded is exactly what this half of the stage was written to stop.
 */

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';

interface AttachmentStub {
  id: string;
  dataSource: string;
  contentHash: string;
  metadata: Record<string, unknown>;
}

/**
 * A DataSource stand-in that answers each of the stage's queries by the one
 * fragment unique to it.
 *
 * Deliberately literal about which query is which: the two passes read the same
 * table with different predicates, and a mock that matched loosely on
 * `count(*)` would happily serve the media pass's answer to the attachment
 * pass's question and make a broken stage look correct.
 */
function makeStage(
  rows: Array<Record<string, unknown>>,
  options: {
    upload?: jest.Mock;
    attachments?: AttachmentStub[];
    createContents?: jest.Mock;
    /** Answer the reclaim's "does another unsettled row need this file?" probe with yes. */
    sharedPathStillPending?: boolean;
    /** Paths the attachment pass still has to be able to read, so the reclaim defers. */
    attachmentPathsInUse?: string[];
  } = {},
) {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  const settled = new Map<string, Record<string, unknown>>();
  let mediaServed = false;
  let attachmentsServed = false;

  const attachmentRows = options.attachments ?? [];

  const dataSource = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('UPDATE')) {
        updates.push({ sql, params });

        if (sql.includes("metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb")) {
          settled.set(params[0] as string, JSON.parse(params[1] as string));
        }

        return [];
      }

      // ---- the reclaim and its preflight ----------------------------------
      // The preflight's pending-bytes sum, from the rows' declared sizes.
      if (sql.includes('sum(size_bytes)')) {
        return [{ bytes: rows.reduce((sum, row) => sum + Number(row.sizeBytes ?? 0), 0) }];
      }

      // The reclaim's does-anything-else-still-need-this-file probe.
      if (sql.includes('SELECT 1 AS present')) {
        return options.sharedPathStillPending ? [{ present: 1 }] : [];
      }

      // The reclaim's other question: is the attachment pass going to need it?
      if (sql.includes('CROSS JOIN LATERAL')) {
        return (options.attachmentPathsInUse ?? []).map((p) => ({ path: p }));
      }

      // ---- the attachment pass -------------------------------------------
      if (sql.includes('data_source AS "dataSource"')) {
        if (attachmentsServed) {
          return [];
        }

        attachmentsServed = true;

        return attachmentRows;
      }

      if (sql.includes("metadata->'MediaAttachments' IS NOT NULL") && sql.includes('count(*)')) {
        return [{ count: attachmentsServed ? 0 : attachmentRows.length }];
      }

      if (sql.includes("AND metadata->'AttachmentFileIds' IS NOT NULL")) {
        return [{ count: 0 }];
      }

      if (sql.includes("jsonb_array_length(metadata->'AttachmentFileIds')")) {
        const stored = [...settled.values()];

        return [
          {
            count: stored.reduce((sum, patch) => sum + (patch.AttachmentFileIds as string[]).length, 0),
            rows: stored.length,
          },
        ];
      }

      if (sql.includes('jsonb_each_text')) {
        const drops: Record<string, number> = {};

        for (const patch of settled.values()) {
          for (const [reason, count] of Object.entries(
            (patch.AttachmentDrops as Record<string, number>) ?? {},
          )) {
            drops[reason] = (drops[reason] ?? 0) + count;
          }
        }

        return Object.entries(drops).map(([reason, count]) => ({ reason, count }));
      }

      if (sql.includes("metadata->>'AttachmentError' IS NOT NULL")) {
        return [...settled.values()]
          .filter((patch) => patch.AttachmentError != null)
          .map((patch) => ({ unit: 'twitter', error: patch.AttachmentError as string }));
      }

      // ---- the media pass -------------------------------------------------
      if (sql.includes('count(*)')) {
        // The uploaded/carried-over probe asks without the media predicate.
        if (sql.includes("FileMediaError' IS NOT NULL")) {
          return [{ count: 0 }];
        }

        return [{ count: rows.length }];
      }

      // The batch read: serve the rows once, then drain.
      if (mediaServed) {
        return [];
      }

      mediaServed = true;

      return rows;
    }),
  };

  const files = {
    uploadWithDedupInfo: options.upload ?? jest.fn(async () => ({ file: { id: 'file-1' }, deduped: false })),
  };

  const contents = {
    createManyDetailed:
      options.createContents ??
      jest.fn(async (_ctx: unknown, inputs: unknown[]) =>
        inputs.map((_input, i) => ({ entity: { id: `content-${i + 1}` } })),
      ),
  };

  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };

  return {
    stage: new MediaStage(dataSource as never, files as never, contents as never, logger as never),
    updates,
    settled,
    files,
    contents,
  };
}

function contextFor(scratchDir: string): StageRunContext {
  return {
    runId: RUN_ID,
    userId: USER_ID,
    stageId: '22222222-2222-4222-8222-222222222222',
    scratchDir,
    progress: jest.fn(async () => undefined),
    log: jest.fn(),
  } as unknown as StageRunContext;
}

describe('MediaStage', () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-mediastage-'));
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it('stores a media file and points the staged row at it', async () => {
    const photo = path.join(scratchDir, 'photo.jpg');
    fs.writeFileSync(photo, 'jpegbytes');

    const { stage, updates, files } = makeStage([
      { id: 'row-1', filename: 'photo.jpg', mediaType: 'image/jpeg', sizeBytes: 9, localPath: photo },
    ]);

    const outcome = await stage.run(contextFor(scratchDir));

    expect(files.uploadWithDedupInfo).toHaveBeenCalledWith(
      { userId: USER_ID },
      expect.objectContaining({ path: photo, contentType: 'image/jpeg' }),
    );
    // The whole point: the row now carries the id the push reads as FileId.
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain('FileId');
    // No hash from the store in this fixture, so no FileSha256 either.
    expect(updates[0].params).toEqual(['row-1', 'file-1', null]);
    expect(outcome.detail).toMatchObject({ uploaded: 1, failed: 0 });
  });

  it('stamps the store’s SHA-256 beside the file id so the content row can key on its bytes', async () => {
    // The `file` federated kind (docs/design/cross-pipeline-identity.md §3.2):
    // toContentInput promotes FileSha256 to (file, sha256:<hash>), so the
    // same photo converges whichever archive delivered it.
    const photo = path.join(scratchDir, 'photo.jpg');
    fs.writeFileSync(photo, 'jpegbytes');
    const sha256 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const { stage, updates } = makeStage(
      [{ id: 'row-1', filename: 'photo.jpg', mediaType: 'image/jpeg', sizeBytes: 9, localPath: photo }],
      { upload: jest.fn(async () => ({ file: { id: 'file-1', hash: sha256 }, deduped: false })) },
    );

    await stage.run(contextFor(scratchDir));

    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain('FileSha256');
    expect(updates[0].params).toEqual(['row-1', 'file-1', sha256]);
  });

  it('counts an already-stored file as deduped rather than uploaded', async () => {
    const photo = path.join(scratchDir, 'again.jpg');
    fs.writeFileSync(photo, 'same');

    const { stage } = makeStage(
      [{ id: 'row-2', filename: 'again.jpg', mediaType: 'image/jpeg', sizeBytes: 4, localPath: photo }],
      { upload: jest.fn(async () => ({ file: { id: 'file-existing' }, deduped: true })) },
    );

    const outcome = await stage.run(contextFor(scratchDir));

    // Dedup is the store's answer, and it is what makes re-importing the same
    // archive cost nothing rather than duplicating every photo.
    expect(outcome.detail).toMatchObject({ uploaded: 0, deduped: 1, failed: 0 });
  });

  it('refuses a path outside the run scratch directory', async () => {
    // The path comes from a parser reading a user-supplied archive; without this
    // the stage would be a primitive for reading any file the API can see.
    const outside = path.join(os.tmpdir(), 'ci-mediastage-outsider.jpg');
    fs.writeFileSync(outside, 'nope');

    const { stage, updates, files } = makeStage([
      { id: 'row-3', filename: 'outsider.jpg', mediaType: 'image/jpeg', sizeBytes: 4, localPath: outside },
    ]);

    const outcome = await stage.run(contextFor(scratchDir));

    expect(files.uploadWithDedupInfo).not.toHaveBeenCalled();
    expect(updates[0].sql).toContain('FileMediaError');
    expect(outcome.partial).toBe(true);

    fs.rmSync(outside, { force: true });
  });

  it('records an unreadable file once instead of retrying it forever', async () => {
    const missing = path.join(scratchDir, 'gone.jpg');

    const { stage, updates } = makeStage([
      { id: 'row-4', filename: 'gone.jpg', mediaType: 'image/jpeg', sizeBytes: 1, localPath: missing },
    ]);

    const outcome = await stage.run(contextFor(scratchDir));

    // Stamped with the error key, which the selection query excludes — so the
    // next attempt skips it rather than spinning on the same dead path.
    expect(updates[0].sql).toContain('FileMediaError');
    expect(outcome.detail).toMatchObject({ failed: 1 });
    expect(outcome.partial).toBe(true);
  });

  it('finishes cleanly on an archive with no media at all', async () => {
    const { stage, files } = makeStage([]);

    const outcome = await stage.run(contextFor(scratchDir));

    expect(files.uploadWithDedupInfo).not.toHaveBeenCalled();
    expect(outcome.partial).toBeUndefined();
    expect(outcome.detail).toMatchObject({ uploaded: 0, failed: 0 });
  });

  it('reclaims the scratch copy once its store copy is durable', async () => {
    // The store copy and the scratch copy are the same bytes twice on one
    // volume; holding both for the whole stage is the 2× peak that ran a real
    // Takeout into the store's free-space floor.
    const photo = path.join(scratchDir, 'reclaim.jpg');
    fs.writeFileSync(photo, 'jpegbytes');

    const { stage, updates } = makeStage([
      { id: 'row-5', filename: 'reclaim.jpg', mediaType: 'image/jpeg', sizeBytes: 9, localPath: photo },
    ]);

    const outcome = await stage.run(contextFor(scratchDir));

    expect(outcome.detail).toMatchObject({ uploaded: 1, failed: 0 });
    // The row points at the stored file, and the scratch bytes are gone.
    expect(updates[0].params).toEqual(['row-5', 'file-1', null]);
    expect(fs.existsSync(photo)).toBe(false);
  });

  it('keeps the scratch copy when the upload fails, so a retry has bytes to read', async () => {
    const photo = path.join(scratchDir, 'kept.jpg');
    fs.writeFileSync(photo, 'jpegbytes');

    const { stage } = makeStage(
      [{ id: 'row-6', filename: 'kept.jpg', mediaType: 'image/jpeg', sizeBytes: 9, localPath: photo }],
      {
        upload: jest.fn(async () => {
          throw new Error('Storage backend has reached its minimum free drive threshold.');
        }),
      },
    );

    const outcome = await stage.run(contextFor(scratchDir));

    expect(outcome.detail).toMatchObject({ failed: 1 });
    expect(fs.existsSync(photo)).toBe(true);
  });

  it('defers the reclaim while another unsettled row still points at the file', async () => {
    const shared = path.join(scratchDir, 'shared.jpg');
    fs.writeFileSync(shared, 'jpegbytes');

    const { stage } = makeStage(
      [{ id: 'row-7', filename: 'shared.jpg', mediaType: 'image/jpeg', sizeBytes: 9, localPath: shared }],
      { sharedPathStillPending: true },
    );

    const outcome = await stage.run(contextFor(scratchDir));

    // Uploaded fine — but the bytes stay for the sibling row that has not
    // settled yet. The last row standing (or end-of-run cleanup) reclaims.
    expect(outcome.detail).toMatchObject({ uploaded: 1 });
    expect(fs.existsSync(shared)).toBe(true);
  });

  it('defers the reclaim while an unsettled message still needs the same bytes', async () => {
    // WhatsApp stages an attached photo TWICE on purpose: once as a standalone
    // media item, once as a `MediaAttachments` descriptor on the message it
    // arrived in, so the message gains the reference while the store's content
    // hash resolves both onto one file. The media pass runs first, so a reclaim
    // that ignored the attachment pass would delete the bytes it has not opened
    // yet — turning the cross-reference into a declined attachment.
    const shared = path.join(scratchDir, 'wa-shared.jpg');
    fs.writeFileSync(shared, 'jpegbytes');

    const { stage } = makeStage(
      [
        {
          id: 'row-10',
          filename: 'wa-shared.jpg',
          mediaType: 'image/jpeg',
          sizeBytes: 9,
          localPath: shared,
        },
      ],
      { attachmentPathsInUse: [shared] },
    );

    const outcome = await stage.run(contextFor(scratchDir));

    expect(outcome.detail).toMatchObject({ uploaded: 1 });
    expect(fs.existsSync(shared)).toBe(true);
  });

  it('refuses to start when the volume cannot hold the media plus the store reserve', async () => {
    const photo = path.join(scratchDir, 'huge.mp4');
    fs.writeFileSync(photo, 'mp4bytes');

    const { stage, files } = makeStage([
      // Declares 100GB of pending media…
      { id: 'row-8', filename: 'huge.mp4', mediaType: 'video/mp4', sizeBytes: 100e9, localPath: photo },
    ]);

    // …against a volume reporting ~1GB free.
    const statfs = jest.spyOn(fs, 'statfsSync').mockReturnValue({
      bavail: 1e9 / 4096,
      bsize: 4096,
      blocks: 2e12 / 4096,
    } as unknown as fs.StatsFsBase<number>);

    try {
      await expect(stage.run(contextFor(scratchDir))).rejects.toThrow(/not enough disk space/);
      // Fail LOUDLY and BEFORE work: nothing uploaded, nothing reclaimed —
      // the alternative was 5,318 quiet per-file failures on a real Takeout.
      expect(files.uploadWithDedupInfo).not.toHaveBeenCalled();
      expect(fs.existsSync(photo)).toBe(true);
    } finally {
      statfs.mockRestore();
    }
  });

  it('skips the preflight when the filesystem cannot be measured', async () => {
    const photo = path.join(scratchDir, 'nostat.jpg');
    fs.writeFileSync(photo, 'jpegbytes');

    const { stage } = makeStage([
      { id: 'row-9', filename: 'nostat.jpg', mediaType: 'image/jpeg', sizeBytes: 9, localPath: photo },
    ]);

    const statfs = jest.spyOn(fs, 'statfsSync').mockImplementation(() => {
      throw new Error('statfs unsupported');
    });

    try {
      // The guard must never be the thing that breaks an import.
      const outcome = await stage.run(contextFor(scratchDir));
      expect(outcome.detail).toMatchObject({ uploaded: 1, failed: 0 });
    } finally {
      statfs.mockRestore();
    }
  });

  describe('communication attachments', () => {
    /** A message row carrying `n` retained files, the shape twitter stages. */
    function messageWith(
      scratch: string,
      files: Array<{ name: string; type?: string; mimetype?: string }>,
      extra: Record<string, unknown> = {},
    ): AttachmentStub {
      return {
        id: 'msg-1',
        dataSource: 'twitter',
        contentHash: 'twitter:dm:9',
        metadata: {
          Text: 'look at this',
          MediaAttachments: files.map((file) => {
            const abs = path.join(scratch, file.name);
            fs.writeFileSync(abs, `bytes-of-${file.name}`);

            return {
              path: abs,
              filename: file.name,
              type: file.type ?? 'image',
              mimetype: file.mimetype ?? 'image/jpeg',
            };
          }),
          ...extra,
        },
      };
    }

    it('uploads a message attachment and stamps the id the push reads', async () => {
      const attachment = messageWith(scratchDir, [{ name: 'dm.jpg' }]);
      const { stage, settled, files } = makeStage([], { attachments: [attachment] });

      const outcome = await stage.run(contextFor(scratchDir));

      expect(files.uploadWithDedupInfo).toHaveBeenCalledWith(
        { userId: USER_ID },
        // The user's own filename, not the retained `twitter-<id>-<hash>.jpg`.
        expect.objectContaining({ filename: 'dm.jpg', contentType: 'image/jpeg' }),
      );
      // `attachmentsFor` in the push builds the column from exactly this key;
      // before this pass existed nothing anywhere wrote it.
      expect(settled.get('msg-1')).toEqual({ AttachmentFileIds: ['file-1'] });
      expect(outcome.detail).toMatchObject({ attachments: { rows: 1, files: 1, declined: 0 } });
      expect(outcome.partial).toBe(false);
    });

    it('reads the bare-path shape as well as the descriptor shape', async () => {
      // facebook and sms_backup_restore write `MediaFilePaths`; twitter and the
      // chat exports write `MediaAttachments`. Both were dead, so the leg has to
      // read both or Messenger stays broken.
      const bare = path.join(scratchDir, 'mms.png');
      fs.writeFileSync(bare, 'pngbytes');

      const { stage, settled, files } = makeStage([], {
        attachments: [
          {
            id: 'msg-2',
            dataSource: 'facebook',
            contentHash: 'fb:msg:3',
            metadata: { MediaFilePaths: [bare] },
          },
        ],
      });

      await stage.run(contextFor(scratchDir));

      expect(files.uploadWithDedupInfo).toHaveBeenCalledWith(
        { userId: USER_ID },
        expect.objectContaining({ filename: 'mms.png' }),
      );
      expect(settled.get('msg-2')).toEqual({ AttachmentFileIds: ['file-1'] });
    });

    it('catalogues each attachment as content when the source opts in', async () => {
      // Messenger's lane: a shared photo is a thing you want to find by itself,
      // not only by reading the thread it arrived in.
      const attachment = messageWith(scratchDir, [{ name: 'a.jpg' }, { name: 'b.mp4', type: 'video' }], {
        AttachmentContent: true,
      });
      const { stage, settled, contents } = makeStage([], { attachments: [attachment] });

      const outcome = await stage.run(contextFor(scratchDir));

      const [, inputs] = contents.createManyDetailed.mock.calls[0];
      expect(inputs).toHaveLength(2);
      // Identity per attachment, so a re-import dedups instead of duplicating.
      expect(inputs[0]).toMatchObject({
        type: 'media',
        external_id: 'file-1',
        external_id_kind: 'file',
        source_system: 'twitter',
        source_id: 'twitter:dm:9:attachment:0',
        title: 'a.jpg',
      });
      expect(inputs[1]).toMatchObject({ source_id: 'twitter:dm:9:attachment:1', title: 'b.mp4' });

      // Index-aligned: attachment i is { file: fileIds[i], content: contentIds[i] }.
      expect(settled.get('msg-1')).toEqual({
        AttachmentFileIds: ['file-1', 'file-1'],
        AttachmentContentIds: ['content-1', 'content-2'],
      });
      expect(outcome.detail).toMatchObject({ attachments: { files: 2, contents: 2 } });
    });

    it('keys a catalogued attachment on its parent’s identity plus the bytes hash, not its index', async () => {
      // Part order is not stable across producers (or across two reads of one
      // archive when a previously unreadable sibling starts working), so the
      // store's SHA-256 names the attachment instead — attachmentIdentity in
      // the registry. The index lane above survives only for a store that
      // returned no hash.
      const sha256 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const attachment = messageWith(scratchDir, [{ name: 'a.jpg' }], { AttachmentContent: true });
      const { stage, contents } = makeStage([], {
        attachments: [attachment],
        upload: jest.fn(async () => ({ file: { id: 'file-1', hash: sha256 }, deduped: false })),
      });

      await stage.run(contextFor(scratchDir));

      const [, inputs] = contents.createManyDetailed.mock.calls[0];
      expect(inputs[0]).toMatchObject({
        source_system: 'twitter',
        source_id: `attachment:twitter:dm:9:${sha256}`,
      });
    });

    it('hangs a mail attachment off the federated (email, <Message-ID>) identity the message itself lands under', async () => {
      // toCommunicationInput keys the message on its RFC Message-ID, so the
      // attachment's parent prefix is that pair — the same one a connection
      // cataloguing the same attachment would mint.
      const sha256 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const attachment: AttachmentStub = {
        ...messageWith(scratchDir, [{ name: 'invoice.pdf', type: 'file', mimetype: 'application/pdf' }], {
          AttachmentContent: true,
          MessageID: 'CAF+QMz-AbC@mail.gmail.com',
        }),
        dataSource: 'gmail',
        contentHash: 'staged-sha1-of-the-message',
      };
      const { stage, contents } = makeStage([], {
        attachments: [attachment],
        upload: jest.fn(async () => ({ file: { id: 'file-1', hash: sha256 }, deduped: false })),
      });

      await stage.run(contextFor(scratchDir));

      const [, inputs] = contents.createManyDetailed.mock.calls[0];
      expect(inputs[0]).toMatchObject({
        type: 'file',
        source_system: 'email',
        source_id: `attachment:CAF+QMz-AbC@mail.gmail.com:${sha256}`,
      });
    });

    it('writes no content rows for a source that did not opt in', async () => {
      // WhatsApp's case: the same bytes already reach staging as a standalone
      // media item, which catalogues itself. A content row here would be a
      // second one over the same file.
      const attachment = messageWith(scratchDir, [{ name: 'wa.jpg' }]);
      const { stage, settled, contents } = makeStage([], { attachments: [attachment] });

      await stage.run(contextFor(scratchDir));

      expect(contents.createManyDetailed).not.toHaveBeenCalled();
      expect(settled.get('msg-1')).not.toHaveProperty('AttachmentContentIds');
    });

    it('counts an attachment it cannot store instead of reporting a clean run', async () => {
      // THE regression. The twitter run reported `status=completed, dropped: 0,
      // dropsByReason: {}` while 566 retained files sat unread in the same
      // scratch tree and were deleted with it.
      const { stage, settled } = makeStage([], {
        attachments: [
          {
            id: 'msg-3',
            dataSource: 'twitter',
            contentHash: 'twitter:dm:4',
            metadata: {
              MediaAttachments: [
                { path: path.join(scratchDir, 'never-written.jpg'), filename: 'never-written.jpg' },
              ],
            },
          },
        ],
      });

      const outcome = await stage.run(contextFor(scratchDir));

      expect(settled.get('msg-3')).toMatchObject({
        AttachmentFileIds: [],
        AttachmentDrops: { media_path_missing: 1 },
      });
      expect(outcome.detail).toMatchObject({ attachments: { files: 0, declined: 1 } });
      // A gap in the import, and the run has to say so.
      expect(outcome.partial).toBe(true);

      const summary = (outcome.detail as Record<string, unknown>).summary as {
        units: Array<{ unit: string; produced: number; drops: Record<string, number> }>;
        dropsByReason: Record<string, number>;
      };
      const unit = summary.units.find((u) => u.unit === 'communication_attachments');
      expect(unit).toMatchObject({ produced: 0, drops: { media_path_missing: 1 } });
      expect(summary.dropsByReason).toMatchObject({ media_missing: 1 });
    });

    it('counts an attachment declared with no path at all', async () => {
      // An iMessage attachment whose row survived the export as a guid with no
      // bytes. Nothing to upload, still a gap.
      const { stage, settled } = makeStage([], {
        attachments: [
          {
            id: 'msg-4',
            dataSource: 'imessage',
            contentHash: 'imsg:7',
            metadata: { MediaAttachments: [{ guid: 'abc', type: 'image' }] },
          },
        ],
      });

      const outcome = await stage.run(contextFor(scratchDir));

      expect(settled.get('msg-4')).toMatchObject({ AttachmentDrops: { attachment_no_path: 1 } });
      expect(outcome.partial).toBe(true);
    });

    it('settles a row that stored nothing, so the pass cannot spin on it', async () => {
      const { stage, settled } = makeStage([], {
        attachments: [
          {
            id: 'msg-5',
            dataSource: 'twitter',
            contentHash: 'twitter:dm:5',
            metadata: { MediaAttachments: [{ path: path.join(scratchDir, 'missing.jpg') }] },
          },
        ],
      });

      await stage.run(contextFor(scratchDir));

      // An EMPTY array is still a settled row: the selection query tests for the
      // key's presence, so this row leaves the predicate and is not retried.
      expect(settled.get('msg-5')).toHaveProperty('AttachmentFileIds', []);
    });

    it('refuses an attachment path outside the run scratch directory', async () => {
      const outside = path.join(os.tmpdir(), 'ci-mediastage-attach-outsider.jpg');
      fs.writeFileSync(outside, 'nope');

      const { stage, settled, files } = makeStage([], {
        attachments: [
          {
            id: 'msg-6',
            dataSource: 'twitter',
            contentHash: 'twitter:dm:6',
            metadata: { MediaAttachments: [{ path: outside, filename: 'outsider.jpg' }] },
          },
        ],
      });

      await stage.run(contextFor(scratchDir));

      expect(files.uploadWithDedupInfo).not.toHaveBeenCalled();
      expect(settled.get('msg-6')).toMatchObject({
        AttachmentDrops: { media_path_escaped_scratch: 1 },
      });

      fs.rmSync(outside, { force: true });
    });

    it('keeps the file ids when the content rows fail', async () => {
      const attachment = messageWith(scratchDir, [{ name: 'c.jpg' }], { AttachmentContent: true });
      const { stage, settled } = makeStage([], {
        attachments: [attachment],
        createContents: jest.fn(async () => {
          throw new Error('content insert exploded');
        }),
      });

      const outcome = await stage.run(contextFor(scratchDir));

      // The bytes landed; only the catalogue row did not. Keeping the file id
      // means the message still shows its photo, and the miss is counted.
      expect(settled.get('msg-1')).toMatchObject({
        AttachmentFileIds: ['file-1'],
        AttachmentDrops: { attachment_content_failed: 1 },
      });
      expect(settled.get('msg-1')).not.toHaveProperty('AttachmentContentIds');
      expect(outcome.partial).toBe(true);
    });

    it('leaves no attachment unit on a run that had none', async () => {
      const photo = path.join(scratchDir, 'solo.jpg');
      fs.writeFileSync(photo, 'jpegbytes');

      const { stage } = makeStage([
        { id: 'row-9', filename: 'solo.jpg', mediaType: 'image/jpeg', sizeBytes: 9, localPath: photo },
      ]);

      const outcome = await stage.run(contextFor(scratchDir));

      const summary = (outcome.detail as Record<string, unknown>).summary as {
        units: Array<{ unit: string }>;
      };
      // A Takeout of nothing but photos must not grow a permanently-empty unit
      // whose `emptyReason` an agent then has to explain away.
      expect(summary.units.map((u) => u.unit)).toEqual(['object_store']);
    });
  });
});
