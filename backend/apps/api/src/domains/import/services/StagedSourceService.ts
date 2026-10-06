import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Repository } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import {
  StagedSourceEntity,
  type StagedSource,
  type StagedSourceKind,
  type StagedSourceStatus,
} from '../entities/StagedSourceEntity';
import { uploadsRoot } from '../sources/importRoots';

/**
 * How long a staged-but-never-imported upload survives the purge sweep. Long
 * enough to ride out any realistic upload→import gap (overnight included);
 * short enough that abandoned multi-GB uploads don't pile up forever. Inbox
 * units have no TTL: their folder is the user's, and its contents wait until
 * a batch consumes them.
 */
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The statuses whose row names no bytes of its own once its run is gone.
 *
 * `staged_sources.run_id` is `ON DELETE SET NULL`, not CASCADE, and that is
 * deliberate: deleting a run must never take the registry row of bytes that
 * still exist. But SET NULL applied to EVERY status, so the rows below — one
 * per completed run, one per released inbox claim — survived their run forever
 * with nothing left to point at. They are what {@link ImportRetentionService}
 * deletes alongside the run itself:
 *
 *  - `consumed` — the run completed and its bytes went with its scratch tree;
 *  - `moved` — the bytes were moved INTO that same tree, and the retention
 *    sweep refuses any run whose tree still exists, so by the time this list is
 *    read they are gone too. The row also holds `staged_sources_active_path_uq`
 *    against its path, so keeping it would make an inbox unit whose run was
 *    retired permanently unclaimable;
 *  - `released` — an inbox claim already handed back; the unit sits in the
 *    user's own folder and the path is claimable again;
 *  - `expired` — a TTL tombstone whose file the purge already deleted.
 *
 * The complement is the reason SET NULL exists — but only one status is in it.
 * A `staged` upload names bytes in the uploads directory right now and has no
 * run to be retired with in the first place. A `claimed` row does name live
 * bytes, yet it cannot simply be left behind either: nothing would ever read it
 * again. So the retirement settles it rather than orphaning it — an UPLOAD goes
 * back to `staged` (see {@link StagedSourceService.restageOrphanedClaims}), an
 * INBOX claim is deleted with the run because the row is only a claim on a file
 * that never left the user's own folder, and the path it held in
 * `staged_sources_active_path_uq` is claimable again. See
 * {@link ImportRetentionService.retireRun}.
 */
export const SOURCE_STATUSES_SPENT_WITH_RUN = [
  'consumed',
  'moved',
  'released',
  'expired',
] as const satisfies readonly StagedSourceStatus[];

/** One row as the Postgres driver hands it back from `RETURNING *`. */
interface StagedSourceRow {
  id: string;
  user_id: string;
  origin: 'upload' | 'inbox';
  drop_id: string | null;
  source_path: string;
  kind: StagedSourceKind;
  original_filename: string | null;
  content_type: string | null;
  /** `bigint` arrives as a string. */
  size_bytes: string | null;
  status: StagedSourceStatus;
  run_id: string | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date | null;
  claimed_at: Date | null;
  consumed_at: Date | null;
}

export interface RegisterUploadInput {
  /** Sanitized public handle for this upload — one per uploaded archive. */
  dropId: string;
  /** Realpath of the staged copy: `<uploadsDir>/<dropId>/<filename>`. */
  sourcePath: string;
  originalFilename?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  /** Override the TTL for this upload. Defaults to {@link UPLOAD_TTL_MS}. */
  ttlMs?: number;
  /** A dropped folder is a directory unit; a zip or single file is a file. */
  kind?: StagedSourceKind;
}

/**
 * The registry of every local source an import run can consume.
 *
 * Two origins, one lifecycle. An UPLOAD is registered the moment its bytes
 * land in the uploads directory — that row is what makes "uploaded now,
 * imported later" survivable, and what the TTL purge reads. An INBOX unit is
 * registered only when a run claims it, because the inbox folder itself is
 * the pending state. From `claimed` on the two are indistinguishable: the
 * unpack stage moves `source_path` into the run's scratch, and the bytes are
 * deleted with the completed run.
 *
 * The claims themselves live in `ImportRunService.startRun`'s transaction
 * (raw SQL — the constrained UPDATE for uploads, the racing INSERT for inbox
 * units); what lives here is registration, the run-lifecycle bookkeeping, and
 * the sweeps. This service and `sources/localAcquire.ts` are the only code
 * that deletes staged bytes, and both re-resolve the path against the staging
 * roots at the deletion site.
 */
@Injectable()
export class StagedSourceService {
  constructor(
    @InjectRepository(StagedSourceEntity)
    private readonly sources: Repository<StagedSourceEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(StagedSourceService.name);
  }

  // -------------------------------------------------------------------------
  // Uploads
  // -------------------------------------------------------------------------

  /**
   * Record a freshly-staged upload.
   *
   * `id` is left to the column's `ci.gen_uuid_v7()` default and read back with
   * RETURNING, so sources sort by insertion time — the same reason every other
   * table in this schema uses `@PrimaryColumn` rather than TypeORM's
   * client-side v4 strategy.
   */
  async registerUpload(ctx: UserServiceContext, input: RegisterUploadInput): Promise<StagedSource> {
    const expiresAt = new Date(Date.now() + (input.ttlMs ?? UPLOAD_TTL_MS));

    const result = await this.sources
      .createQueryBuilder()
      .insert()
      .into(StagedSourceEntity)
      .values({
        userId: ctx.userId,
        origin: 'upload',
        dropId: input.dropId,
        sourcePath: input.sourcePath,
        kind: input.kind ?? 'file',
        originalFilename: input.originalFilename ?? null,
        contentType: input.contentType ?? null,
        sizeBytes: input.sizeBytes ?? null,
        status: 'staged',
        expiresAt,
      })
      .returning('*')
      .execute();

    // `raw` is the DRIVER's rows, so its keys are the COLUMN names — `drop_id`,
    // `expires_at` — not the entity's properties. Casting it to the entity was a
    // lie that typechecked: `dropId` came back undefined, the upload response
    // carried a null id, and starting a run answered "dropId is required".
    // Mapped explicitly so a column rename fails here rather than at the caller.
    const source = mapRow(result.raw[0] as StagedSourceRow);

    this.logger.log('Registered staged upload', {
      dropId: input.dropId,
      userId: ctx.userId,
      sizeBytes: input.sizeBytes ?? null,
    });

    return source;
  }

  async findByDropId(ctx: UserServiceContext, dropId: string): Promise<StagedSource | null> {
    return this.sources.findOne({ where: { userId: ctx.userId, dropId } });
  }

  /** Uploads still awaiting an import decision, newest first. */
  async listStagedUploads(ctx: UserServiceContext): Promise<StagedSource[]> {
    return this.sources.find({
      where: { userId: ctx.userId, origin: 'upload', status: 'staged' },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Discard an upload the user no longer wants.
   *
   * Only a `staged` upload still has bytes to remove and no run to disturb —
   * a CLAIMED upload belongs to its run now, and deleting it out from under a
   * running unpack is refused rather than raced. An `expired` tombstone may
   * also be dismissed (row-only; the purge already took the file).
   */
  async releaseUpload(ctx: UserServiceContext, dropId: string): Promise<boolean> {
    const source = await this.findByDropId(ctx, dropId);

    if (source == null || (source.status !== 'staged' && source.status !== 'expired')) {
      return false;
    }

    if (source.status === 'staged') {
      await this.removeStagedUploadDir(source.sourcePath);
    }

    await this.sources.delete({ id: source.id });

    return true;
  }

  /**
   * Reclaim still-staged uploads past their TTL.
   *
   * The row is taken out of the staged pool FIRST, with a compare-and-swap on
   * the very state `startRun`'s claim also competes for, and only then are the
   * bytes deleted. That ordering is the whole point.
   *
   * The previous shape read the stale rows, then deleted each file, then
   * stamped `expired` with an UNCONSTRAINED update — so a run that claimed an
   * upload in the gap between the read and the delete had its archive removed
   * out from under it AND its live `claimed` row overwritten with an `expired`
   * tombstone. The unpack then failed with "no claimed source" over bytes that
   * no longer existed, and there was nothing left to say where they went. A
   * constrained update cannot do that: the claim and the purge race for the
   * same `status = 'staged'` row and exactly one of them wins.
   *
   * A failed delete puts the row back to `staged` so the next sweep retries it
   * — the property the old file-first ordering was protecting, kept.
   *
   * Runs {@link StagedSourceService.restageOrphanedClaims} first, so an upload
   * that lost its run reaches this sweep at all.
   */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    await this.restageOrphanedClaims();

    const stale = await this.sources.find({
      where: { origin: 'upload', status: 'staged', expiresAt: LessThan(now) },
    });

    let reclaimed = 0;

    for (const source of stale) {
      // The CAS. `status: 'staged'` in the WHERE is what makes a run that
      // claimed this upload since the read above win the race outright.
      const claimed = await this.sources.update(
        { id: source.id, status: 'staged', expiresAt: LessThan(now) },
        { status: 'expired' },
      );

      if ((claimed.affected ?? 0) === 0) {
        this.logger.log('Expired upload was claimed by a run before the sweep reached it; leaving it', {
          dropId: source.dropId,
        });
        continue;
      }

      try {
        await this.removeStagedUploadDir(source.sourcePath);
      } catch (err: unknown) {
        // Put it back: an `expired` row whose file survived is invisible to
        // this sweep forever, which is how bytes leak.
        await this.sources.update({ id: source.id, status: 'expired' }, { status: 'staged' });

        this.logger.warn('Could not reclaim an expired upload; will retry next sweep', {
          dropId: source.dropId,
          error: (err as Error).message,
        });
        continue;
      }

      reclaimed += 1;
    }

    if (stale.length > 0) {
      this.logger.log('Purged expired uploads', { expired: stale.length, reclaimed });
    }

    return reclaimed;
  }

  /**
   * Put uploads whose run no longer exists back in the staged pool.
   *
   * `run_id` is `ON DELETE SET NULL`, so a `claimed` row can outlive the run
   * that claimed it, and such a row is a dead end in every direction:
   * `listStagedUploads` does not show it, `releaseUpload` refuses it, a fresh
   * `startRun` is told the upload "has already been claimed by another import
   * run" that no longer exists, {@link StagedSourceService.purgeExpired} reads
   * only `staged`, and {@link StagedSourceService.dropDirIsLive} counts
   * `claimed` as live and so holds the bytes out of the orphan sweep too. Row
   * and archive both, forever. That is what the schema's promise of a backstop
   * for such a row amounted to before this existed.
   *
   * {@link ImportRetentionService.retireRun} does this transactionally with
   * the run delete, so no code path leaves one behind. This is the floor under
   * the CONSTRAINT — a restore, an operator's `DELETE`, a future caller — and
   * it is safe precisely because such a row is unreachable: every reader of a
   * claim finds it by `run_id` ({@link StagedSourceService.findByRunId}), so
   * nothing can be part-way through using one.
   *
   * `staged` with a fresh window, which is the same answer `release` gives an
   * upload whose run ended without consuming: the archive is back on the
   * uploads list, back under the purge, and importable by the same dropId.
   */
  private async restageOrphanedClaims(): Promise<void> {
    const restaged = await this.sources.update(
      { origin: 'upload', status: 'claimed', runId: IsNull() },
      { status: 'staged', claimedAt: null, expiresAt: new Date(Date.now() + UPLOAD_TTL_MS) },
    );

    if ((restaged.affected ?? 0) > 0) {
      // `warn`: reaching this means a run row went away outside `retireRun`.
      this.logger.warn('Re-staged uploads whose run no longer exists', {
        restaged: restaged.affected,
      });
    }
  }

  /**
   * Sweep the uploads directory for bytes NO ROW accounts for — the two crash
   * windows registration cannot cover:
   *
   *  - a file in `incoming/` whose request died between multer's write and the
   *    rename into its drop directory;
   *  - a `<dropId>/` directory whose request died between the rename and the
   *    registry INSERT (or whose claimed row lost its run to a run delete).
   *
   * Both are swept only past the TTL, so nothing in-flight is ever taken.
   * This sweep — not the happy path — is what makes "staged bytes cannot
   * leak" structurally true.
   */
  async sweepUploadOrphans(now: Date = new Date()): Promise<number> {
    const root = uploadsRoot();
    const cutoff = now.getTime() - UPLOAD_TTL_MS;
    let removed = 0;

    let entries: string[];

    try {
      entries = await readdir(root);
    } catch {
      // No uploads directory yet: nothing staged, nothing orphaned.
      return 0;
    }

    for (const name of entries) {
      const fullPath = path.join(root, name);

      try {
        const info = await stat(fullPath);

        if (info.mtimeMs > cutoff) {
          continue;
        }

        if (name === 'incoming') {
          // Sweep the files INSIDE incoming individually — the directory
          // itself stays (multer writes into it).
          for (const orphan of await readdir(fullPath)) {
            const orphanPath = path.join(fullPath, orphan);

            if ((await stat(orphanPath)).mtimeMs <= cutoff) {
              await rm(orphanPath, { force: true });
              removed += 1;
            }
          }

          continue;
        }

        if (await this.dropDirIsLive(name)) {
          continue;
        }

        await this.removeDropDir(fullPath);
        removed += 1;
      } catch (err: unknown) {
        this.logger.warn('Orphan sweep skipped an entry', {
          entry: name,
          error: (err as Error).message,
        });
      }
    }

    if (removed > 0) {
      this.logger.log('Swept orphaned upload bytes', { removed });
    }

    return removed;
  }

  // -------------------------------------------------------------------------
  // The shared run lifecycle
  // -------------------------------------------------------------------------

  /**
   * The source a run claimed, if it still holds a live claim. Filtered to
   * `claimed`/`moved` deliberately: a stage retried after its claim was
   * released (or its upload re-staged) must fail with "no claimed source"
   * rather than acquire a path some newer run now owns.
   *
   * Scoped by user as well as by run. The run id alone is enough to identify
   * the row, so this is not the gate that keeps accounts apart — it is the
   * check that makes a mismatch impossible to reach: a stage job whose payload
   * names one user and whose run belongs to another finds no source and fails
   * honestly, rather than moving somebody else's archive into this run's
   * scratch tree.
   */
  async findByRunId(userId: string, runId: string): Promise<StagedSource | null> {
    return this.sources.findOne({ where: { userId, runId, status: In(['claimed', 'moved']) } });
  }

  /**
   * Live claims (claimed or moved) for a set of paths — the inbox scan's
   * "already importing" lookup.
   *
   * Deliberately NOT scoped by user. The inbox is one shared folder, so a unit
   * another account is importing is unavailable to this one — the claim index
   * is appliance-wide for the same reason. What the caller does with the answer
   * IS scoped: see {@link ImportInboxService.scan}, which reports another
   * user's claim as `claimed` without handing over their run id.
   */
  async findActiveByPaths(paths: string[]): Promise<StagedSource[]> {
    if (paths.length === 0) {
      return [];
    }

    return this.sources.find({
      where: { sourcePath: In(paths), status: In(['claimed', 'moved']) },
    });
  }

  /**
   * Point one account's live inbox claims at the folder their inbox moved to.
   *
   * A claim records the unit's real path, and the unpack stage moves exactly
   * that path. When the boot migration renames an account's inbox folder (see
   * `ImportInboxService.migrateInboxFoldersToUserIds`), a run that claimed a
   * unit before the upgrade but has not moved it yet would look for it under
   * the old folder, fail, and leave the unit looking unclaimed in the new one.
   * `moved` rows are rewritten too so the scan's "already importing" lookup
   * matches exactly what it did before the move.
   *
   * Both arguments are realpaths. Matched with `left(...)` rather than LIKE,
   * because the old folder names carry `_`, which LIKE reads as a wildcard.
   *
   * @returns how many claims were rewritten.
   */
  async rebaseInboxClaims(userId: string, fromDir: string, toDir: string): Promise<number> {
    // CTE-wrapped so the outer command is a SELECT; see the claim UPDATE in
    // `ImportRunService.startRun` for the driver detail.
    const rows = await this.sources.query<Array<{ id: string }>>(
      `WITH rebased AS (
         UPDATE ci_import.staged_sources
            SET source_path = $3 || substr(source_path, length($2) + 1), updated_at = now()
          WHERE user_id = $1::uuid
            AND origin = 'inbox'
            AND status IN ('claimed', 'moved')
            AND left(source_path, length($2) + 1) = $2 || '/'
        RETURNING id)
       SELECT id FROM rebased`,
      [userId, fromDir, toDir],
    );

    return rows.length;
  }

  /** The unpack stage finished moving the source into scratch. */
  async markMoved(id: string): Promise<void> {
    await this.sources.update({ id, status: 'claimed' }, { status: 'moved' });
  }

  /**
   * Drop the now-empty `<uploadsDir>/<dropId>/` wrapper once its file has
   * moved into a run's scratch — otherwise every import leaves one husk
   * behind until the orphan sweep. rmdir, NOT recursive, deliberately: an
   * empty directory is the only thing this may ever remove, so the worst a
   * tampered row can do is fail. Best-effort, and a no-op for inbox units,
   * which have no wrapper.
   */
  async reclaimMovedUploadDir(source: Pick<StagedSource, 'origin' | 'sourcePath'>): Promise<void> {
    if (source.origin !== 'upload') {
      return;
    }

    const dropDir = path.dirname(path.resolve(source.sourcePath));
    const relative = path.relative(uploadsRoot(), dropDir);

    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      return;
    }

    await rmdir(dropDir).catch(() => undefined);
  }

  /**
   * The run completed (fully or partially): the source is consumed, and its
   * bytes go with the run's scratch. Idempotent — `finishRun` can be reached
   * again by the recovery sweep, and a second stamp is a no-op.
   */
  async markConsumed(runId: string): Promise<void> {
    await this.sources.update(
      { runId, status: In(['claimed', 'moved']) },
      { status: 'consumed', consumedAt: new Date() },
    );
  }

  /**
   * The run ended without consuming (cancelled, or failed before the move).
   * What that means depends on the origin:
   *
   *  - an INBOX claim is released — the path is free for a fresh claim, and
   *    the unit is still sitting in the user's folder;
   *  - an UPLOAD is RE-STAGED (`staged`, no run, fresh TTL) — it reappears in
   *    the uploads list, stays importable by the same dropId, and falls back
   *    under the purge. `released` would strand its file: invisible to the
   *    list, untouchable by the purge, undeletable by the user.
   *
   * Constrained to `claimed` either way — once the bytes moved to scratch,
   * they wait there for a retry and go with the run.
   */
  async release(runId: string): Promise<void> {
    const inbox = await this.sources.update(
      { runId, origin: 'inbox', status: 'claimed' },
      { status: 'released' },
    );
    const uploads = await this.sources.update(
      { runId, origin: 'upload', status: 'claimed' },
      { status: 'staged', runId: null, claimedAt: null, expiresAt: new Date(Date.now() + UPLOAD_TTL_MS) },
    );

    if ((inbox.affected ?? 0) + (uploads.affected ?? 0) > 0) {
      this.logger.log('Released staged source claim', {
        runId,
        restagedUploads: uploads.affected ?? 0,
      });
    }
  }

  /**
   * Is anything still entitled to the bytes in `<uploadsDir>/<dropId>/`?
   *
   * Two independent reasons to keep them, and the second is the one the status
   * test alone got wrong:
   *
   *  - a row in a live STATUS (`staged`/`claimed`/`moved`) — an upload awaiting
   *    its import decision, or one a run currently holds;
   *  - a row of ANY status whose run has not finished. A run whose stage failed
   *    releases its claim (the upload goes back to `staged`, so this is usually
   *    the same answer) — but a run that was retried, or one whose row was
   *    stamped by a racing sweep, can hold an unfinished run against a status
   *    this test would otherwise read as dead. Deleting an in-flight run's
   *    archive is unrecoverable, and keeping bytes an extra hour costs disk, so
   *    the tie goes to the run.
   */
  private async dropDirIsLive(dropId: string): Promise<boolean> {
    const liveStatus = await this.sources.exist({
      where: { dropId, status: In(['staged', 'claimed', 'moved']) },
    });

    if (liveStatus) {
      return true;
    }

    const rows = (await this.sources.query(
      `SELECT EXISTS (
                SELECT 1
                  FROM ci_import.staged_sources s
                  JOIN ci_import.import_runs r ON r.id = s.run_id
                 WHERE s.drop_id = $1 AND r.finished_at IS NULL
              ) AS live`,
      [dropId],
    )) as Array<{ live: boolean }>;

    return rows[0]?.live === true;
  }

  /** Delete a registered upload's bytes: its whole `<uploadsDir>/<dropId>/` directory. */
  private async removeStagedUploadDir(sourcePath: string): Promise<void> {
    await this.removeDropDir(path.dirname(path.resolve(sourcePath)));
  }

  /**
   * The one place upload bytes are removed outside the acquisition move.
   * Defense in depth at the deletion site: containment against the uploads
   * root is checked HERE — segment-wise, on the resolved path — so a row
   * edited to point elsewhere is refused where the deleting happens.
   * Idempotent: a directory already gone is a no-op, not an error.
   */
  private async removeDropDir(dropDir: string): Promise<void> {
    const resolved = path.resolve(dropDir);
    const relative = path.relative(uploadsRoot(), resolved);

    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Refusing to delete outside the uploads directory: ${dropDir}`);
    }

    await rm(resolved, { recursive: true, force: true });
  }
}

function mapRow(row: StagedSourceRow): StagedSource {
  return {
    id: row.id,
    userId: row.user_id,
    origin: row.origin,
    dropId: row.drop_id,
    sourcePath: row.source_path,
    kind: row.kind,
    originalFilename: row.original_filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    status: row.status,
    runId: row.run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    claimedAt: row.claimed_at,
    consumedAt: row.consumed_at,
  };
}
