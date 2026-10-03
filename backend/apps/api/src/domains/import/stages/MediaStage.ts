import fs from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import plimit from 'p-limit';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { FileService } from '@ci/domains/files';
import {
  ContentService,
  type CreateContentDto,
  type SourceIdentity,
  attachmentIdentity,
  emailIdentity,
  platformIdentity,
} from '@ci/domains/memory';

import type { MediaAttachment } from '../datasources/timeline';
import {
  communicationAttachmentsFrom,
  FILE_CLASSIFICATIONS,
  SOURCE_TYPE,
  wantsAttachmentContentFrom,
} from '../push/canonical';
import { FACEBOOK_MESSENGER_SOURCE_SYSTEM, isFacebookMessengerRow } from '../push/inputs';
import { dropReasonFor } from '../telemetry/dropReasons';
import { buildStageSummary, SUMMARY_KEY, type StageSummary } from '../telemetry/stageSummary';
import type { ImportStageRunner, StageOutcome, StageRunContext } from '../types';

/** Staged media rows read per batch. Files are uploaded one at a time within it. */
const MEDIA_BATCH = 200;

/**
 * Staged rows read per attachment batch.
 *
 * Smaller than {@link MEDIA_BATCH} because the unit is a ROW, not a file, and a
 * row can carry a dozen of them — a batch of 200 twitter DMs is closer to 400
 * uploads than 200.
 */
const ATTACHMENT_BATCH = 100;

/** The zero-work attachment tally, so both exit paths report the same shape. */
const EMPTY_ATTACHMENT_COUNTS = { rows: 0, files: 0, contents: 0, declined: 0 } as const;

/** One staged row that has bytes somewhere on disk. */
interface MediaRow {
  id: string;
  filename: string | null;
  mediaType: string | null;
  sizeBytes: string | number | null;
  localPath: string;
}

/** One staged row whose metadata carries attachments for the message it becomes. */
interface AttachmentRow {
  id: string;
  dataSource: string;
  classification?: string | null;
  mediaType?: string | null;
  contentHash: string;
  metadata: Record<string, unknown> | null;
}

/** What one row's attachment pass settled, before it is stamped back onto the row. */
interface AttachmentOutcome {
  /** `ci.files` ids, in descriptor order. Becomes `metadata.AttachmentFileIds`. */
  fileIds: string[];
  /** `ci.content` ids for the SAME attachments, index-aligned with `fileIds`. */
  contentIds: string[];
  /** Closed-vocabulary slug → count, for the descriptors this leg declined. */
  drops: Record<string, number>;
  /** The first decline's prose, so the stage summary has something to show. */
  firstError: string | null;
}

/**
 * Put an archive's bytes into the object store.
 *
 * The leg the consolidation left out. Upstream uploaded every photo, video,
 * voicemail and MMS part through `ci-server/media.ts` before sending the rows
 * that describe them; the port brought the read side across — `contentFileRef`
 * looks for `metadata.FileId`, `toContentInput` stamps it onto `external_id` —
 * but nothing ever wrote it. So a photo import produced `ci.content` rows
 * pointing at a file that did not exist, `EventMediaLoader` resolved them to
 * null (no gallery thumbnail, no downloadable attachment), and the actual bytes
 * were deleted with the run's scratch tree while the run reported success.
 *
 * ## Why a stage and not a step inside the push
 *
 * It is bounded by something else. Parse reads a tree, push writes Postgres,
 * and this talks to the object store — on a photo archive it is the longest leg
 * of the import by a wide margin, and the one most likely to die halfway. A
 * stage gets its own progress row, its own ETA and stage-granular retry, so an
 * object-store hiccup at photo 40,000 resumes here instead of re-running the
 * push. It runs BEFORE push because the push reads what it writes.
 *
 * ## Resumability
 *
 * Per row, like the push, and for the same reason — but keyed on the work's own
 * output rather than a separate ledger column: a row is done when its metadata
 * carries a `FileId`, so the selection query IS the resume point and shrinks as
 * the stage drains. A row whose bytes could not be read is stamped with
 * `FileMediaError` and skipped by the same query, so one unreadable file cannot
 * spin the stage forever.
 *
 * Dedup is the store's answer, not ours: `uploadWithDedupInfo` hashes the bytes
 * and returns the existing file when they are already held, which is what makes
 * a re-import of the same archive cost nothing and makes a `-edited` duplicate
 * share one object.
 *
 * ## Disk
 *
 * This stage DUPLICATES bytes: every media file exists in the run's scratch
 * tree and, once stored, in the object store — which on the appliance is the
 * same physical volume. Two guards keep that from filling the disk mid-stage
 * the way it did on a real 351GB Takeout (5,318 files refused by the store's
 * free-space floor): a preflight that refuses to start without plausible
 * headroom ({@link assertStoreHeadroom}), and a per-file reclaim that frees
 * each file's scratch copy as soon as its store copy is durable
 * ({@link reclaimScratchCopy}), which is what caps the peak near 1.5× the
 * media bytes instead of 2×.
 */
/**
 * How many media files are uploaded at once.
 *
 * Eight rather than "as many as the batch holds": every one of these is an
 * open file handle plus an in-flight object-store PUT, and a 500-row batch of
 * large videos run flat out would hold 500 of each. Eight is enough to keep the
 * store busy through the latency of the previous request — which is the whole
 * point — while staying a bounded amount of memory and file descriptors.
 */
const MEDIA_CONCURRENCY = Number(process.env.CI_IMPORT_MEDIA_CONCURRENCY ?? 8);

const limit = plimit(MEDIA_CONCURRENCY);

/**
 * Disk the preflight demands beyond what the pending media already occupies,
 * as a fraction of the pending bytes.
 *
 * The stage copies every media file into the object store, which on the
 * appliance lives on the SAME volume as the scratch tree — so without
 * reclamation its peak footprint is 2× the media bytes (scratch copy + store
 * copy), which is exactly how a 351GB Takeout ran the store into its
 * threshold with 5,318 files still to go. With the per-file reclaim in
 * `uploadOne` the two copies mostly do NOT coexist: each file's scratch bytes
 * are freed as its store copy lands, so the peak is nearer 1.5× than 2× —
 * the scratch copy is already on disk, and the extra headroom only has to
 * cover the store copies that pile up ahead of their reclaims (in-flight
 * uploads, rows sharing one file, failed rows that keep their bytes for a
 * retry) plus thumbnails and store metadata. Half the pending bytes is the
 * honest ceiling for that: generous against uneven reclamation, far below
 * the 2× that would refuse imports the stage can actually finish.
 */
const PREFLIGHT_HEADROOM_FACTOR = 0.5;

/**
 * What the object store keeps in reserve and will not let writes consume.
 *
 * MinIO refuses PUTs while its backing disk is near-full — the observed
 * failure was "Storage backend has reached its minimum free drive threshold"
 * with double-digit gigabytes still free — so a preflight that only demands
 * the bytes themselves passes and then dies at the store's floor anyway. A
 * couple of percent of the volume, capped, approximates that floor without
 * hard-coding one MinIO version's rule.
 */
const STORE_RESERVE_FRACTION = 0.02;
const STORE_RESERVE_CAP_BYTES = 100 * 1024 ** 3; // 100 GiB

@Injectable()
export class MediaStage implements ImportStageRunner {
  readonly kind = 'media' as const;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly files: FileService,
    private readonly contents: ContentService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(MediaStage.name);
  }

  async run(context: StageRunContext): Promise<StageOutcome> {
    const remaining = await this.pendingCount(context.runId);
    const alreadyDone = await this.uploadedCount(context.runId);
    const attachmentsRemaining = await this.pendingAttachmentCount(context.runId);
    const attachmentsDone = await this.settledAttachmentCount(context.runId);
    // Both passes are units of the same stage, so they share one denominator —
    // otherwise a twitter archive whose media pass has nothing to do reports
    // `0/0 completed` while it is still uploading 566 attachments.
    const total = remaining + alreadyDone + attachmentsRemaining + attachmentsDone;
    const carriedOver = alreadyDone + attachmentsDone;

    await context.progress({ processed: carriedOver, total, phase: 'uploading' });

    if (remaining === 0 && attachmentsRemaining === 0) {
      // An archive with no media at all — a Takeout of nothing but JSON — is the
      // common case, not an edge one. Say so rather than reporting a bare zero.
      return {
        processed: carriedOver,
        total,
        detail: {
          uploaded: 0,
          deduped: 0,
          failed: 0,
          carriedOver,
          attachments: EMPTY_ATTACHMENT_COUNTS,
          [SUMMARY_KEY]: await this.summarize(context.runId, carriedOver === 0),
        },
      };
    }

    await this.assertStoreHeadroom(context);

    // Read once, before anything is reclaimed: the media pass and the
    // attachment pass can name the same bytes. See attachmentPathsInUse.
    // Skipped when there is no media pass to reclaim anything — `null` is the
    // defer-everything answer, which is what a run with no reclaims wants.
    const attachmentPaths = remaining > 0 ? await this.attachmentPathsInUse(context.runId) : null;

    let uploaded = 0;
    let deduped = 0;
    let failed = 0;

    while (remaining > 0) {
      const batch = await this.nextBatch(context.runId);

      if (batch.length === 0) {
        break;
      }

      // Concurrent, because this stage is LATENCY-bound, not throughput-bound.
      // Each file is a stat, a read, an object-store PUT, a thumbnail and an
      // UPDATE — a chain of round trips during which this process is doing
      // nothing at all. Run one at a time, a real Apple Photos library moved at
      // 3.8 files/sec: 1,574 photos took 411 seconds, 71% of the whole import,
      // while the push stage beside it was managing 100,000 rows/minute.
      //
      // The work is independent per row — no shared state, no ordering, and the
      // dedupe is resolved by content hash inside the object store rather than
      // by arrival order — so the only thing bounding it is how many uploads the
      // object store should be asked to hold at once.
      const results = await Promise.all(
        batch.map((row) =>
          limit(async () => {
            const outcome = await this.uploadOne(context, row, attachmentPaths);

            // Counted here, inside the limiter, so progress advances as each
            // file lands rather than jumping a whole batch at a time.
            if (outcome === 'uploaded') {
              uploaded += 1;
            } else if (outcome === 'deduped') {
              deduped += 1;
            } else {
              failed += 1;
            }

            await context.progress({
              processed: carriedOver + uploaded + deduped + failed,
              total,
              phase: 'uploading',
            });

            return outcome;
          }),
        ),
      );

      // `uploadOne` resolves every row to an outcome and never rejects — it
      // marks a failure on the row and returns 'failed' — so Promise.all here
      // cannot abandon a partly-uploaded batch. Asserting it rather than
      // trusting it: a future refactor that lets it throw would otherwise lose
      // the rest of the batch silently.
      if (results.length !== batch.length) {
        throw new Error(`media batch resolved ${results.length} of ${batch.length} rows`);
      }
    }

    this.logger.log('Uploaded staged media', { runId: context.runId, uploaded, deduped, failed });

    const attachments = await this.runAttachments(context, {
      processedBefore: carriedOver + uploaded + deduped + failed,
      total,
    });

    return {
      processed: carriedOver + uploaded + deduped + failed + attachments.rows,
      total,
      // A file the run was handed and could not store is a gap in the import,
      // and the run must say so rather than reporting a clean success over
      // bytes nobody will be able to open. An attachment the leg DECLINED counts
      // the same way: the whole reason this pass exists is that 566 of them were
      // dropped under a `dropped: 0` green tick.
      partial: failed > 0 || attachments.declined > 0,
      detail: {
        uploaded,
        deduped,
        failed,
        carriedOver,
        attachments: {
          rows: attachments.rows,
          files: attachments.files,
          contents: attachments.contents,
          declined: attachments.declined,
        },
        [SUMMARY_KEY]: await this.summarize(context.runId, false),
      },
    };
  }

  /**
   * Refuse to start when the store cannot plausibly hold what this stage is
   * about to give it — the same fail-loudly-up-front contract the unpack
   * stage's disk preflight makes, for the same reason: without it, the store
   * hits its floor mid-stage and thousands of files fail quietly into the
   * ledger (5,318 on a real Takeout) after the scratch tree's lifetime has
   * already been spent.
   *
   * Measured against the SCRATCH volume, which on the appliance is also the
   * store's volume — the topology this guard exists for. When the store is
   * remote this measures the wrong disk, but then the reclaim keeps local
   * usage flat and the demanded headroom is modest, so the guard errs small.
   * No statfs, or nothing pending, means no preflight: the guard must never
   * be the thing that breaks an import.
   *
   * The demand is deliberately NOT the naive 2× (scratch copy + store copy):
   * see PREFLIGHT_HEADROOM_FACTOR for why reclamation makes half the pending
   * bytes the honest requirement, plus the store's own reserve.
   *
   * Counts the MEDIA pass only. The attachment pass stores bytes too, but its
   * descriptors mostly carry no declared size, so folding them in would add
   * zeroes rather than accuracy — and the ones that ARE also standalone media
   * items are already in this sum. Another way this guard errs small.
   */
  private async assertStoreHeadroom(context: StageRunContext): Promise<void> {
    // Sum of DECLARED sizes; rows without one count zero, so this is a floor —
    // acceptable for a guard whose alternative is no guard at all.
    const [row] = (await this.dataSource.query(
      `SELECT COALESCE(sum(size_bytes), 0)::bigint AS bytes
         FROM ci_import.staged_items
        WHERE ${this.mediaPredicate()}`,
      [context.runId, this.classifications],
    )) as Array<{ bytes: string | number }>;

    const pendingBytes = Number(row?.bytes ?? 0);

    if (pendingBytes === 0) {
      return;
    }

    let free: number;
    let total: number;
    try {
      const stats = fs.statfsSync(context.scratchDir);

      free = Number(stats.bavail) * Number(stats.bsize);
      total = Number(stats.blocks) * Number(stats.bsize);
    } catch {
      return;
    }

    const reserve = Math.min(total * STORE_RESERVE_FRACTION, STORE_RESERVE_CAP_BYTES);
    const needed = pendingBytes * PREFLIGHT_HEADROOM_FACTOR + reserve;

    if (needed > free) {
      throw new Error(
        `not enough disk space to store this import's media: ${(pendingBytes / 1e9).toFixed(1)}GB of ` +
          `media needs ~${(needed / 1e9).toFixed(1)}GB free (headroom plus the object store's reserve) ` +
          `but only ${(free / 1e9).toFixed(1)}GB is free on that volume — free up space and retry the ` +
          `stage. Nothing was uploaded, so a retry starts where this run stands.`,
      );
    }
  }

  /**
   * Store the attachments that ride a MESSAGE, rather than being one.
   *
   * The other half of the port, and the half that was never wired up. A photo
   * someone sent reaches staging in one of two shapes — a rich descriptor under
   * `metadata.MediaAttachments` (twitter, gmail, iMessage, the LLM chat
   * exports) or a bare path under `metadata.MediaFilePaths` (facebook,
   * sms_backup_restore) — and NOTHING read either one. `attachmentsFor` in the
   * push builds `communications.attachments` from `AttachmentFileIds` /
   * `AttachmentContentIds`; no stage ever wrote those keys, so the column was
   * `[]` on all 325,198 communications in the QA corpus while 566 retained
   * twitter files sat in the run scratch and were deleted with it.
   *
   * ## Why here and not in the push
   *
   * Because the push READS what this writes. `toCommunicationInput` needs the
   * ids in metadata by the time it builds its input, and this stage already
   * runs before it for exactly that reason. It is also the only stage that
   * talks to the object store, so an attachment upload gets the same bounded
   * concurrency, progress and stage-granular retry every other upload gets.
   *
   * ## The unit is a ROW, not a descriptor
   *
   * A row settles atomically: every descriptor on it is attempted, then the
   * whole result is stamped in one UPDATE. That makes the selection query the
   * resume point, exactly like the media pass — a row is done when it carries
   * `AttachmentFileIds`, even if that array is empty because every attachment
   * was declined. An empty array is a settled row, not an unattempted one, so
   * one unreadable file cannot spin the stage forever.
   *
   * Re-running is safe rather than merely tolerable: the object store dedups on
   * the bytes' hash and the content rows dedup on their provenance triple, so a
   * row re-settled after a crash resolves onto the same ids.
   */
  private async runAttachments(
    context: StageRunContext,
    progress: { processedBefore: number; total: number },
  ): Promise<{ rows: number; files: number; contents: number; declined: number }> {
    let rows = 0;
    let files = 0;
    let contents = 0;
    let declined = 0;

    for (;;) {
      const batch = await this.nextAttachmentBatch(context.runId);

      if (batch.length === 0) {
        break;
      }

      // Concurrency is bounded at the ROW here, and a row's own descriptors are
      // uploaded one after another inside it. Nesting `limit()` again per
      // descriptor would deadlock: the outer task holds a slot while awaiting an
      // inner one that can never be scheduled once all slots are held by outer
      // tasks doing the same.
      const results = await Promise.all(
        batch.map((row) =>
          limit(async () => {
            const outcome = await this.settleAttachments(context, row);

            rows += 1;
            files += outcome.fileIds.length;
            contents += outcome.contentIds.length;
            declined += totalDrops(outcome.drops);

            await context.progress({
              processed: progress.processedBefore + rows,
              total: progress.total,
              phase: 'uploading',
            });

            return outcome;
          }),
        ),
      );

      if (results.length !== batch.length) {
        throw new Error(`attachment batch resolved ${results.length} of ${batch.length} rows`);
      }
    }

    if (rows > 0) {
      this.logger.log('Stored communication attachments', {
        runId: context.runId,
        rows,
        files,
        contents,
        declined,
      });
    }

    return { rows, files, contents, declined };
  }

  /**
   * Attempt every attachment on one row, then stamp the result onto it.
   *
   * Never throws. A descriptor this leg cannot store is COUNTED — under the same
   * closed vocabulary the media pass uses, since the causes are the same ones —
   * rather than skipped, because a silent skip here is the bug: the twitter run
   * reported `dropped: 0, dropsByReason: {}` over 566 files it never opened.
   */
  private async settleAttachments(context: StageRunContext, row: AttachmentRow): Promise<AttachmentOutcome> {
    const metadata = row.metadata ?? {};
    const outcome: AttachmentOutcome = { fileIds: [], contentIds: [], drops: {}, firstError: null };
    const decline = (slug: string, detail: string) => {
      outcome.drops[slug] = (outcome.drops[slug] ?? 0) + 1;
      outcome.firstError ??= `${slug}: ${detail}`;
    };

    // Declared but unusable — an iMessage attachment whose row survived the
    // export with a guid and no bytes, say. `communicationAttachmentsFrom` drops
    // these because there is nothing to upload; they are still a gap in the
    // import and have to be said out loud.
    for (let i = 0; i < pathlessAttachmentCount(metadata); i += 1) {
      decline('attachment_no_path', 'attachment was declared with no local path');
    }

    const descriptors = communicationAttachmentsFrom(metadata);
    // Index into the DESCRIPTOR list, not into the successful subset: it is half
    // of each content row's provenance triple, so it has to name the same
    // attachment on a re-run where a previously unreadable sibling now works.
    const stored: StoredAttachment[] = [];

    for (const [index, descriptor] of descriptors.entries()) {
      const storedFile = await this.storeAttachment(context, descriptor, decline);

      if (storedFile == null) {
        continue;
      }

      outcome.fileIds.push(storedFile.fileId);
      stored.push({ index, descriptor, ...storedFile });
    }

    // The lane split: Messenger opts in because a shared photo is a thing you
    // want to find by itself, not only by reading the thread it arrived in; an
    // MMS part is bare bytes and lands as a file alone. WhatsApp opts out for a
    // third reason — its attachments ALSO reach staging as standalone media
    // items, which already catalogue themselves.
    if (wantsAttachmentContentFrom(metadata) && stored.length > 0) {
      await this.adoptPreviousKeys(context, row, stored);

      try {
        const created = await this.contents.createManyDetailed(
          { userId: context.userId },
          stored.map((plan) => attachmentContentInput(row, plan)),
        );

        // All-or-nothing, so the two arrays stay index-aligned: `attachmentsFor`
        // documents attachment i as `{ file: fileIds[i], content: contentIds[i] }`,
        // and a partial list would silently re-pair every entry after the gap.
        outcome.contentIds = created.length === stored.length ? created.map((r) => r.entity.id) : [];
      } catch (err) {
        decline('attachment_content_failed', (err as Error).message);
      }
    }

    await this.markAttachments(row.id, outcome);

    return outcome;
  }

  /**
   * Move this row's attachments' content rows from the key this pass used
   * before #2912 onto the one it uses now, so the insert that follows finds
   * them instead of writing a twin beside each.
   *
   * Before #2912 every attachment that is not mail hung off its staged row's
   * data source. A Messenger message is keyed under `facebook_messenger`, so its
   * attachments now are too, with the same source_id: the old key is the same
   * identity with the data source as the parent's system. Migration
   * 20261002005332 moved the rows present when it ran. A row can still come
   * back under the old key, from a portability archive exported before it or a
   * writer still on the old code, and without this a re-import would insert a
   * second row over the same file, one the message's `attachments` never names.
   *
   * Best effort: if the move fails, the insert runs exactly as it would have
   * without it.
   */
  private async adoptPreviousKeys(
    context: StageRunContext,
    row: AttachmentRow,
    stored: readonly StoredAttachment[],
  ): Promise<void> {
    const moves = new Map<string, { from: string; to: string; sourceIds: string[] }>();

    for (const plan of stored) {
      const now = attachmentContentIdentity(row, plan);
      const before = attachmentContentIdentity(row, plan, row.dataSource);

      if (before.system === now.system) {
        continue;
      }

      const key = `${before.system}\u0000${now.system}`;
      const move = moves.get(key) ?? { from: before.system, to: now.system, sourceIds: [] };

      move.sourceIds.push(now.id);
      moves.set(key, move);
    }

    for (const move of moves.values()) {
      try {
        const moved = await this.contents.rekeySourceSystem({ userId: context.userId }, move);

        if (moved.length > 0) {
          this.logger.log('Moved attachment content onto the source system of its message', {
            runId: context.runId,
            from: move.from,
            to: move.to,
            rows: moved.length,
          });
        }
      } catch (err) {
        this.logger.warn(
          'Could not move attachment content onto the source system of its message; inserting as before',
          {
            runId: context.runId,
            from: move.from,
            to: move.to,
            error: (err as Error).message,
          },
        );
      }
    }
  }

  /**
   * Put ONE attachment's bytes in the object store, or say why not.
   *
   * Same containment rule as {@link uploadOne}, and for the same reason: the
   * path comes from a parser that read it out of an archive the user supplied,
   * and this stage must not become a primitive for reading any file the API
   * process can see.
   */
  private async storeAttachment(
    context: StageRunContext,
    descriptor: MediaAttachment,
    decline: (slug: string, detail: string) => void,
  ): Promise<{ fileId: string; sha256: string | null } | null> {
    const resolved = path.resolve(descriptor.path);

    if (!withinScratch(context.scratchDir, resolved)) {
      decline(
        'media_path_escaped_scratch',
        `attachment path is outside the run scratch directory: ${descriptor.path}`,
      );

      return null;
    }

    try {
      const stats = await stat(resolved);

      if (!stats.isFile()) {
        decline('media_not_a_file', `attachment path is not a file: ${resolved}`);

        return null;
      }

      const { file } = await this.files.uploadWithDedupInfo(
        { userId: context.userId },
        {
          path: resolved,
          // The name the user had, not the retained basename: twitter's
          // `retainAttachment` prefixes its copies `twitter-<id>-<hash>.jpg`.
          filename: descriptor.filename ?? path.basename(resolved),
          contentType: descriptor.mimetype,
          size: stats.size,
          // Same reason as the media pass: a description is an Ollama round trip
          // per file, and the enrichment pipeline reaches these on its own.
          skipDescription: true,
        },
      );

      // The store's SHA-256 of the bytes, which is the attachment's identity
      // (attachmentContentInput). Null only if the store did not hash — it
      // always does for a path upload — and then the row keys on its index.
      return { fileId: file.id, sha256: file.hash ?? null };
    } catch (err) {
      const message = (err as Error).message;

      this.logger.warn('Could not store a communication attachment; continuing with the rest', {
        runId: context.runId,
        error: message,
      });
      decline(mediaFailureReason(err), message);

      return null;
    }
  }

  /** Rows carrying attachments that this pass has not settled yet. */
  private attachmentPredicate(): string {
    return `run_id = $1::uuid
        AND (metadata->'MediaAttachments' IS NOT NULL OR metadata->'MediaFilePaths' IS NOT NULL)
        AND metadata->'AttachmentFileIds' IS NULL`;
  }

  private async nextAttachmentBatch(runId: string): Promise<AttachmentRow[]> {
    return this.dataSource.query<AttachmentRow[]>(
      `SELECT id, data_source AS "dataSource", classification, media_type AS "mediaType",
              content_hash AS "contentHash", metadata
         FROM ci_import.staged_items
        WHERE ${this.attachmentPredicate()}
        ORDER BY id
        LIMIT ${ATTACHMENT_BATCH}`,
      [runId],
    );
  }

  private async pendingAttachmentCount(runId: string): Promise<number> {
    const [row] = (await this.dataSource.query(
      `SELECT count(*)::int AS count FROM ci_import.staged_items WHERE ${this.attachmentPredicate()}`,
      [runId],
    )) as Array<{ count: number }>;

    return row?.count ?? 0;
  }

  /** Rows an earlier attempt already settled — the attachment pass's resume point. */
  private async settledAttachmentCount(runId: string): Promise<number> {
    const [row] = (await this.dataSource.query(
      `SELECT count(*)::int AS count
         FROM ci_import.staged_items
        WHERE run_id = $1::uuid AND metadata->'AttachmentFileIds' IS NOT NULL`,
      [runId],
    )) as Array<{ count: number }>;

    return row?.count ?? 0;
  }

  /**
   * Stamp one row's settled attachments.
   *
   * A shallow `||` merge rather than nested `jsonb_set` calls: four keys are
   * being written at once and every one of them is top-level, so the merge says
   * what is happening in one operator instead of four nested rewrites.
   *
   * `AttachmentFileIds` is ALWAYS written, empty array included — it is what the
   * resume predicate tests, so a row that settled with nothing stored must still
   * carry it or the stage would re-attempt it on every run forever.
   */
  private async markAttachments(id: string, outcome: AttachmentOutcome): Promise<void> {
    const patch: Record<string, unknown> = { AttachmentFileIds: outcome.fileIds };

    if (outcome.contentIds.length > 0) {
      patch.AttachmentContentIds = outcome.contentIds;
    }

    if (Object.keys(outcome.drops).length > 0) {
      patch.AttachmentDrops = outcome.drops;
    }

    if (outcome.firstError != null) {
      patch.AttachmentError = outcome.firstError.slice(0, 500);
    }

    await this.dataSource.query(
      `UPDATE ci_import.staged_items
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
        WHERE id = $1::uuid`,
      [id, JSON.stringify(patch)],
    );
  }

  /**
   * The stage's account of itself, read back out of the rows it settled.
   *
   * Counted with two GROUP BYs over `staged_items` rather than from the
   * in-process counters, for three reasons, and every one of them is a
   * correctness reason rather than a stylistic one:
   *
   *  - it covers a RESUME. `uploaded`/`deduped`/`failed` are this attempt's;
   *    the rows carry every attempt's, so a stage that died at photo 40,000
   *    and resumed reports the whole import rather than the tail of it.
   *  - it aggregates the failure reasons that were ALREADY being written per
   *    row and never read. `markFailed` has always stamped
   *    `metadata.FileMediaError` — so on a run where files could not be
   *    stored, the reason for every one of them was sitting in the database
   *    and the stage detail said `failed: N` and nothing else.
   *  - it is O(reasons), not O(files). This corpus has single stages of
   *    700k+ items; the instruction is aggregate by reason, never per row, and
   *    two grouped counts are the cheapest honest way to do it.
   */
  private async summarize(runId: string, noInput: boolean): Promise<StageSummary> {
    const [stored] = (await this.dataSource.query(
      `SELECT count(*)::int AS count
         FROM ci_import.staged_items
        WHERE run_id = $1::uuid AND metadata->>'FileId' IS NOT NULL`,
      [runId],
    )) as Array<{ count: number }>;

    const failures = (await this.dataSource.query(
      // Grouped on the SLUG, not the prose. `FileMediaError` holds an
      // exception message — a path, an errno, an object-store response — which
      // is unique per row and therefore useless as a group key; `markFailed`
      // now writes the closed-vocabulary slug beside it. COALESCE covers rows
      // stamped by a build before that key existed.
      `SELECT COALESCE(metadata->>'FileMediaErrorReason', 'media_upload_failed') AS reason,
              count(*)::int AS count
         FROM ci_import.staged_items
        WHERE run_id = $1::uuid AND metadata->>'FileMediaError' IS NOT NULL
        GROUP BY 1`,
      [runId],
    )) as Array<{ reason: string; count: number }>;

    // Up to five real examples so a person has something to go and look at,
    // one per reason. Never one per row: a photo library that lost 4,000 files
    // to a full object store must not write 4,000 rows of telemetry.
    const samples = (await this.dataSource.query(
      `SELECT DISTINCT ON (metadata->>'FileMediaErrorReason')
              COALESCE(metadata->>'FileMediaErrorReason', 'media_upload_failed') AS reason,
              COALESCE(filename, '(unnamed)') AS filename,
              left(metadata->>'FileMediaError', 200) AS error
         FROM ci_import.staged_items
        WHERE run_id = $1::uuid AND metadata->>'FileMediaError' IS NOT NULL
        ORDER BY metadata->>'FileMediaErrorReason', id
        LIMIT 5`,
      [runId],
    )) as Array<{ reason: string; filename: string; error: string }>;

    const drops: Record<string, number> = {};

    for (const row of failures) {
      drops[row.reason] = (drops[row.reason] ?? 0) + row.count;
    }

    const attachments = await this.summarizeAttachments(runId);

    return buildStageSummary({
      stage: 'media',
      // Two units, both stores: a media ITEM's own bytes and the attachments
      // that ride a message are uploaded by different passes with different
      // resume keys, and rolling them into one number would hide exactly the
      // failure this stage was extended to stop hiding.
      unitKind: 'store',
      units: [{ unit: 'object_store', produced: stored?.count ?? 0, drops }, ...attachments.units],
      zeroInputReason: noInput ? 'no_input' : 'nothing_pending',
      samples: [
        ...samples.map((row) => ({
          reason: dropReasonFor(row.reason),
          slug: row.reason,
          detail: `${row.filename}: ${row.error}`,
        })),
        ...attachments.samples,
      ],
    });
  }

  /**
   * The attachment pass's account of itself, read back out of the rows.
   *
   * Same three reasons the media summary is a query rather than a counter: it
   * covers a resume, it aggregates reasons already being written per row, and it
   * is O(reasons) rather than O(attachments).
   *
   * The unit is omitted entirely when the run had no attachments at all, so a
   * Takeout of nothing but JSON does not grow a permanently-empty unit whose
   * `emptyReason` an agent then has to explain away.
   */
  private async summarizeAttachments(runId: string): Promise<{
    units: Array<{ unit: string; produced: number; drops: Record<string, number> }>;
    samples: Array<{ reason: ReturnType<typeof dropReasonFor>; slug: string; detail: string }>;
  }> {
    const [stored] = (await this.dataSource.query(
      `SELECT COALESCE(sum(jsonb_array_length(metadata->'AttachmentFileIds')), 0)::int AS count,
              count(*)::int AS rows
         FROM ci_import.staged_items
        WHERE run_id = $1::uuid AND jsonb_typeof(metadata->'AttachmentFileIds') = 'array'`,
      [runId],
    )) as Array<{ count: number; rows: number }>;

    const declines = (await this.dataSource.query(
      // The per-row ledgers, summed. `jsonb_each_text` is strict, so rows
      // without the key contribute no lateral rows rather than erroring.
      `SELECT entry.key AS reason, sum(entry.value::int)::int AS count
         FROM ci_import.staged_items s,
              jsonb_each_text(s.metadata->'AttachmentDrops') AS entry
        WHERE s.run_id = $1::uuid
          AND jsonb_typeof(s.metadata->'AttachmentDrops') = 'object'
        GROUP BY 1`,
      [runId],
    )) as Array<{ reason: string; count: number }>;

    if ((stored?.rows ?? 0) === 0 && declines.length === 0) {
      return { units: [], samples: [] };
    }

    const samples = (await this.dataSource.query(
      `SELECT COALESCE(data_source, '(unknown)') AS unit,
              left(metadata->>'AttachmentError', 200) AS error
         FROM ci_import.staged_items
        WHERE run_id = $1::uuid AND metadata->>'AttachmentError' IS NOT NULL
        ORDER BY id
        LIMIT 3`,
      [runId],
    )) as Array<{ unit: string; error: string }>;

    const drops: Record<string, number> = {};

    for (const row of declines) {
      drops[row.reason] = (drops[row.reason] ?? 0) + row.count;
    }

    return {
      units: [{ unit: 'communication_attachments', produced: stored?.count ?? 0, drops }],
      samples: samples.map((row) => ({
        reason: dropReasonFor(row.error.split(':')[0]),
        slug: row.error.split(':')[0],
        detail: `${row.unit}: ${row.error}`,
      })),
    };
  }

  /**
   * Store one row's bytes and point the row at the result.
   *
   * The path is re-validated against the run's own scratch directory before it
   * is opened. It arrives from a parser, which read it out of an archive the
   * user supplied, and this stage would otherwise be a primitive for reading
   * any file the API process can see. `realpath` resolution happens inside
   * `stat`/the read, so the containment check compares resolved segments rather
   * than string prefixes.
   */
  private async uploadOne(
    context: StageRunContext,
    row: MediaRow,
    attachmentPaths: ReadonlySet<string> | null,
  ): Promise<'uploaded' | 'deduped' | 'failed'> {
    const resolved = path.resolve(row.localPath);

    if (!withinScratch(context.scratchDir, resolved)) {
      await this.markFailed(
        row.id,
        'media_path_escaped_scratch',
        `media path is outside the run scratch directory: ${row.localPath}`,
      );

      return 'failed';
    }

    try {
      const stats = await stat(resolved);

      if (!stats.isFile()) {
        await this.markFailed(row.id, 'media_not_a_file', `media path is not a file: ${resolved}`);

        return 'failed';
      }

      const { file, deduped } = await this.files.uploadWithDedupInfo(
        { userId: context.userId },
        {
          path: resolved,
          filename: row.filename ?? path.basename(resolved),
          contentType: row.mediaType ?? undefined,
          size: stats.size,
          // The description pass is an Ollama round trip per file. An archive
          // import is tens of thousands of files that the enrichment pipeline
          // will reach on its own schedule; doing it inline would make this
          // stage LLM-bound rather than store-bound.
          skipDescription: true,
        },
      );

      await this.markUploaded(row.id, file.id, file.hash ?? null);
      await this.reclaimScratchCopy(context, row, resolved, attachmentPaths);

      return deduped ? 'deduped' : 'uploaded';
    } catch (err) {
      const reason = (err as Error).message;

      this.logger.warn('Could not store staged media; continuing with the rest', {
        runId: context.runId,
        stagedItemId: row.id,
        error: reason,
      });

      await this.markFailed(row.id, mediaFailureReason(err), reason);

      return 'failed';
    }
  }

  /**
   * Free a file's scratch bytes the moment its store copy is durable.
   *
   * The store copy and the scratch copy are the same bytes twice on what is
   * one volume on the appliance, and end-of-run cleanup is too late to matter:
   * holding both for the whole stage is a 2× peak, and a 351GB Takeout ran the
   * store into its free-space floor exactly that way (5,318 files lost). The
   * row's `FileId` is already committed by the time this runs, so a crash
   * between upload and reclaim costs nothing but bytes the run's cleanup
   * sweeps anyway.
   *
   * Deferred while any UNSETTLED row still points at the same file — a settled
   * row has `FileId`; a failed one does not, and keeps its bytes so a media
   * retry has something to read. Deferred too while an unsettled ATTACHMENT row
   * names the same path, which is a different question and needs its own
   * answer: see {@link attachmentPathsInUse}. Best-effort: a reclaim that cannot
   * delete changes nothing the end-of-run reclaim will not fix.
   */
  private async reclaimScratchCopy(
    context: StageRunContext,
    row: MediaRow,
    resolved: string,
    attachmentPaths: ReadonlySet<string> | null,
  ): Promise<void> {
    // `null` is "could not tell", and the safe answer to that is to keep the
    // bytes — the attachment pass has not run yet and cannot re-fetch them.
    if (attachmentPaths == null || attachmentPaths.has(resolved)) {
      return;
    }

    try {
      const others = (await this.dataSource.query(
        `SELECT 1 AS present
           FROM ci_import.staged_items
          WHERE run_id = $1::uuid
            AND id <> $2::uuid
            AND COALESCE(intermediate_location, original_location) = $3
            AND metadata->>'FileId' IS NULL
          LIMIT 1`,
        [context.runId, row.id, row.localPath],
      )) as unknown[];

      if (others.length > 0) {
        return;
      }

      await rm(resolved, { force: true });
    } catch (err) {
      this.logger.debug('Could not reclaim a stored media file; end-of-run cleanup will', {
        runId: context.runId,
        stagedItemId: row.id,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Scratch paths an unsettled attachment row still has to be able to read.
   *
   * The two passes of this stage can name the SAME bytes on purpose. WhatsApp
   * emits an attached photo twice — once as a standalone media item, once as a
   * `MediaAttachments` descriptor on the message it arrived in — precisely so
   * the message gains the reference while the object store's content hash
   * resolves both onto one file. The media pass runs first and now reclaims, so
   * without this the reclaim would delete the descriptor's bytes before
   * {@link runAttachments} ever opened them: the deliberate cross-reference
   * would come back as a declined attachment and a partial run.
   *
   * Read ONCE, before the media loop. Nothing settles an attachment row until
   * the attachment pass runs, so the answer cannot go stale underneath the
   * loop, and one query beats a jsonb scan per uploaded file on an archive with
   * tens of thousands of them.
   *
   * `null` means the question could not be answered, and every reclaim defers
   * on it. Losing some disk headroom is the cost of a query that failed;
   * deleting bytes the next pass needs is not recoverable.
   */
  private async attachmentPathsInUse(runId: string): Promise<ReadonlySet<string> | null> {
    try {
      const rows = (await this.dataSource.query(
        `SELECT DISTINCT x.path AS path
           FROM ci_import.staged_items s
           CROSS JOIN LATERAL (
             SELECT a->>'path' AS path
               FROM jsonb_array_elements(
                      CASE WHEN jsonb_typeof(s.metadata->'MediaAttachments') = 'array'
                           THEN s.metadata->'MediaAttachments'
                           ELSE '[]'::jsonb END) a
             UNION ALL
             SELECT f #>> '{}' AS path
               FROM jsonb_array_elements(
                      CASE WHEN jsonb_typeof(s.metadata->'MediaFilePaths') = 'array'
                           THEN s.metadata->'MediaFilePaths'
                           ELSE '[]'::jsonb END) f
           ) x
          WHERE ${this.attachmentPredicate()}
            AND x.path IS NOT NULL`,
        [runId],
      )) as Array<{ path: string }>;

      // Resolved, because that is the form `reclaimScratchCopy` tests and the
      // form `storeAttachment` will open them by.
      return new Set(rows.map((row) => path.resolve(row.path)));
    } catch (err) {
      this.logger.warn('Could not read the attachment paths in use; keeping every scratch copy', {
        runId,
        error: (err as Error).message,
      });

      return null;
    }
  }

  /**
   * Rows with bytes on disk that this stage has not settled.
   *
   * The predicate mirrors `isMediaItem` — a binary MIME, or one of the
   * file-backed classifications — expressed in SQL so the selection stays a
   * single indexed scan rather than a fetch-and-filter over a whole run.
   */
  private mediaPredicate(): string {
    return `run_id = $1::uuid
        AND (media_type ~ '^(image|video|audio)/' OR classification = ANY($2::text[]))
        AND COALESCE(intermediate_location, original_location) IS NOT NULL
        AND metadata->>'FileId' IS NULL
        AND metadata->>'FileMediaError' IS NULL`;
  }

  private get classifications(): string[] {
    return [...FILE_CLASSIFICATIONS];
  }

  private async nextBatch(runId: string): Promise<MediaRow[]> {
    return this.dataSource.query<MediaRow[]>(
      `SELECT id, filename, media_type AS "mediaType", size_bytes AS "sizeBytes",
              COALESCE(intermediate_location, original_location) AS "localPath"
         FROM ci_import.staged_items
        WHERE ${this.mediaPredicate()}
        ORDER BY id
        LIMIT ${MEDIA_BATCH}`,
      [runId, this.classifications],
    );
  }

  private async pendingCount(runId: string): Promise<number> {
    const [row] = (await this.dataSource.query(
      `SELECT count(*)::int AS count FROM ci_import.staged_items WHERE ${this.mediaPredicate()}`,
      [runId, this.classifications],
    )) as Array<{ count: number }>;

    return row?.count ?? 0;
  }

  /** Rows an earlier attempt already settled — the resume's starting count. */
  private async uploadedCount(runId: string): Promise<number> {
    const [row] = (await this.dataSource.query(
      `SELECT count(*)::int AS count
         FROM ci_import.staged_items
        WHERE run_id = $1::uuid
          AND (metadata->>'FileId' IS NOT NULL OR metadata->>'FileMediaError' IS NOT NULL)`,
      [runId],
    )) as Array<{ count: number }>;

    return row?.count ?? 0;
  }

  /**
   * Stamp the stored file's id onto the row.
   *
   * Written into `metadata` rather than a new column because that is the seam
   * the push already reads: `toCanonical` carries metadata through and
   * `contentFileRef` looks for exactly this key.
   *
   * `FileSha256` rides alongside: the store's hash of the bytes, which
   * `toContentInput` promotes to the row's identity (the `file` federated
   * kind — docs/design/cross-pipeline-identity.md §3.2) so the same photo or
   * document converges whichever archive or connection delivered it. Absent
   * when the store did not hash, and then the row keys on its staged triple
   * as before.
   */
  private async markUploaded(id: string, fileId: string, sha256: string | null): Promise<void> {
    await this.dataSource.query(
      `UPDATE ci_import.staged_items
          SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{FileId}', to_jsonb($2::text), true)
                      || CASE WHEN $3::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('FileSha256', $3::text) END
        WHERE id = $1::uuid`,
      [id, fileId, sha256],
    );
  }

  /**
   * Mark a row this stage could not store, with BOTH halves of the reason.
   *
   * `FileMediaError` keeps the prose it always kept — it is what the resume
   * predicate tests for, and it is the only thing that names the actual file
   * and errno. `FileMediaErrorReason` is the closed-vocabulary slug beside it,
   * and it exists because prose cannot be grouped: every row's message is
   * different, so `SELECT reason, count(*)` over the prose returns one row per
   * failed file, which at this corpus's scale is not a summary of anything.
   */
  private async markFailed(id: string, slug: string, message: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE ci_import.staged_items
          SET metadata = jsonb_set(
                jsonb_set(COALESCE(metadata, '{}'::jsonb), '{FileMediaError}', to_jsonb($2::text), true),
                '{FileMediaErrorReason}', to_jsonb($3::text), true)
        WHERE id = $1::uuid`,
      [id, message.slice(0, 500), slug],
    );
  }
}

/**
 * Is this resolved path inside the run's own scratch tree?
 *
 * Shared by both passes so the rule cannot drift between a media item and an
 * attachment. `realpath` resolution happens inside `stat`/the read, so this
 * compares resolved segments rather than string prefixes.
 */
function withinScratch(scratchDir: string, resolved: string): boolean {
  const relative = path.relative(path.resolve(scratchDir), resolved);

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Sum a slug-keyed drop ledger. */
function totalDrops(drops: Record<string, number>): number {
  return Object.values(drops).reduce((sum, n) => sum + n, 0);
}

/**
 * Attachments the row DECLARED that carry no path to upload.
 *
 * Counted from the raw metadata rather than by diffing against
 * `communicationAttachmentsFrom`, because that function also collapses the same
 * file declared under both keys — a legitimate de-dup that must not be reported
 * as a lost attachment.
 */
function pathlessAttachmentCount(metadata: Record<string, unknown>): number {
  let count = 0;

  if (Array.isArray(metadata.MediaAttachments)) {
    for (const entry of metadata.MediaAttachments) {
      const filePath = (entry as Record<string, unknown> | null)?.path;

      if (!entry || typeof entry !== 'object' || typeof filePath !== 'string' || filePath.length === 0) {
        count += 1;
      }
    }
  }

  if (Array.isArray(metadata.MediaFilePaths)) {
    for (const entry of metadata.MediaFilePaths) {
      if (typeof entry !== 'string' || entry.length === 0) {
        count += 1;
      }
    }
  }

  return count;
}

/** One attachment this pass put in the store, with what the store said about it. */
interface StoredAttachment {
  /** Index into the DESCRIPTOR list — see settleAttachments. */
  index: number;
  fileId: string;
  /** The store's SHA-256 of the bytes; null only if it did not hash. */
  sha256: string | null;
  descriptor: MediaAttachment;
}

/**
 * The identity of the message this attachment hangs off — the SAME pair the
 * push will key the communication on, so the attachment's id is a suffix of
 * its parent's. Mail keys on the federated `(email, <Message-ID>)` pair
 * (`toCommunicationInput` does the identical mapping from `metadata.MessageID`);
 * a Messenger message under `facebook_messenger`
 * (`toFacebookMessengerCommunicationInput`); everything else on the staged
 * row's platform triple.
 *
 * The Messenger case was missing, so every Messenger attachment was catalogued
 * as `facebook` while its message was `facebook_messenger` — and the explorer's
 * Facebook source filter returned thousands of chat attachments.
 *
 * `system` is the platform half; it defaults to the one the push uses. Passing
 * the row's data source instead gives the identity this pass used before #2912
 * (see {@link MediaStage.adoptPreviousKeys}).
 */
function attachmentParentIdentity(row: AttachmentRow, system = parentSourceSystem(row)): SourceIdentity {
  const messageId = row.metadata?.MessageID;

  return (
    emailIdentity(typeof messageId === 'string' ? messageId : undefined) ??
    platformIdentity(system, row.contentHash)
  );
}

/** The system the push keys this row's message on, when it is not the mail pair. */
function parentSourceSystem(row: AttachmentRow): string {
  return isFacebookMessengerRow(row) ? FACEBOOK_MESSENGER_SOURCE_SYSTEM : row.dataSource;
}

/**
 * The identity of the `ci.content` row over one stored attachment: its parent's
 * identity plus the bytes' SHA-256, or the index lane when the store returned
 * no hash. `system` as for {@link attachmentParentIdentity}.
 */
function attachmentContentIdentity(
  row: AttachmentRow,
  plan: StoredAttachment,
  system = parentSourceSystem(row),
): SourceIdentity {
  return plan.sha256
    ? attachmentIdentity(attachmentParentIdentity(row, system), plan.sha256)
    : platformIdentity(system, row.contentHash, 'attachment', String(plan.index));
}

/**
 * The `ci.content` row that catalogues one stored attachment.
 *
 * Identity is the parent message's identity plus the SHA-256 of the bytes
 * (`attachmentIdentity`, docs/design/cross-pipeline-identity.md §3.3) — NOT
 * the attachment's index, which is what this used to be. Part order is not
 * stable across producers (a Gmail API fetch and a MIME parse of the same
 * message need not agree), so an index-keyed row could not converge with a
 * connection that catalogues the same attachment, and even a re-import of the
 * same archive forked a row whenever a previously unreadable sibling started
 * working. The bytes hash names the attachment whoever delivered it. The
 * index lane survives only for a store that returned no hash, so the row is
 * still stable per re-import rather than duplicated.
 *
 * `external_id` is the stored file — that is what a consumer of this row
 * actually needs, and it is what `contentFileRef`/`EventMediaLoader` resolve
 * media through everywhere else.
 */
function attachmentContentInput(row: AttachmentRow, plan: StoredAttachment): CreateContentDto {
  const input: CreateContentDto = {
    // 'file' passes through for a non-media attachment (an email's PDF); every
    // other descriptor type is media. Same rule the descriptor lane applies.
    type: plan.descriptor.type === 'file' ? 'file' : 'media',
    external_id: plan.fileId,
    external_id_kind: 'file',
    source_type: SOURCE_TYPE,
    ...(() => {
      const identity = attachmentContentIdentity(row, plan);

      return { source_system: identity.system, source_id: identity.id };
    })(),
  };

  if (plan.descriptor.filename) {
    input.title = plan.descriptor.filename;
  }

  if (plan.descriptor.mimetype) {
    input.mimetype = plan.descriptor.mimetype;
  }

  // The media's URL on the source service, when the export recorded one — the
  // handle that survives after the local copy is purged.
  if (plan.descriptor.url) {
    input.url = plan.descriptor.url;
  }

  return input;
}

/**
 * Which closed-vocabulary slug an upload failure counts under.
 *
 * Only three buckets are worth separating, and they are separated by what a
 * person would DO about them: bytes the archive promised and did not contain
 * (nothing to do — the export is short), bytes that are there and unreadable
 * (a permissions or corruption problem on this appliance), and the object
 * store refusing work (capacity, credentials, a service that is down —
 * re-runnable). Everything else lands in the last of those, because guessing
 * finer from an exception message is how a vocabulary stops being closed.
 */
function mediaFailureReason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;

  if (code === 'ENOENT') {
    return 'media_path_missing';
  }

  if (code === 'EISDIR' || code === 'ENOTDIR') {
    return 'media_not_a_file';
  }

  return 'media_upload_failed';
}
