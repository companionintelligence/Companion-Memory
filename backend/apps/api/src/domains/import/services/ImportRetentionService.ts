import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { FILE_CLASSIFICATIONS } from '../push/canonical';

import { pushableRunSql, unstoredMediaExistsSql } from './ImportRunService';
import { ImportScratchService } from './ImportScratchService';
import { SOURCE_STATUSES_SPENT_WITH_RUN, UPLOAD_TTL_MS } from './StagedSourceService';

/**
 * The run states from which no further work can start on its own.
 *
 * `partial` belongs here: it is a terminal SUCCESS-ish state — an export whose
 * sixth parser choked still imported the other five — and excluding it would
 * mean the most common outcome of a large multi-source Takeout is the one that
 * never reclaims. `queued` and `running` are absent by construction.
 *
 * Terminal status is NECESSARY but never SUFFICIENT: `import_runs.status` is a
 * derived cache over `import_stages` (see the class note on
 * `ImportRunService`), so every predicate below also asks the stage rows.
 */
const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'partial', 'cancelled'] as const;

/**
 * A stage in either of these has work that has not finished: a `queued` one
 * only while its run is still open (see {@link liveStageExistsSql}).
 */
const LIVE_STAGE_STATUSES = ['queued', 'running'] as const;

/** The staging tables the payload sweep empties, in cascade-safe order. */
const PAYLOAD_TABLES = ['staged_items', 'staged_entities'] as const;

type PayloadTable = (typeof PAYLOAD_TABLES)[number];

/** One run the sweep is considering, with enough context to log about it. */
interface RetentionCandidate {
  readonly id: string;
  readonly userId: string;
  readonly label: string | null;
  readonly status: string;
  readonly finishedAt: Date | null;
}

/**
 * One run a discard is considering, with every eligibility answer evaluated by
 * the database rather than inferred from the run row.
 *
 * They are kept apart rather than reduced to one boolean so the caller can say
 * WHICH refusal it hit: "still working", "there is no parse here to discard"
 * and "its photos are only on disk" are three different problems with three
 * different remedies, and a single flag would collapse them into a shrug.
 */
interface DiscardCandidate extends RetentionCandidate {
  /** {@link pushableRunSql} — is the Sync card still offering this payload? */
  readonly pushable: boolean;
  /**
   * No stage `running`, and none `queued` in a run that is still open
   * ({@link liveStageExistsSql}). The stage rows, not the status cache.
   */
  readonly quiet: boolean;
  /**
   * {@link unstoredMediaExistsSql} — does a staged media row still name bytes
   * that exist nowhere but this run's scratch tree? Asked in SQL, by the same
   * expression all four sweep queries apply, rather than left to the scratch
   * stat to imply. See {@link ImportRetentionService.discardRun}.
   */
  readonly unstoredMedia: boolean;
}

/** What a discard's media stage had already stored by the time it was called. */
interface MediaAlreadyStored {
  /** Distinct `ci.files` rows named by this run's staged metadata. */
  readonly mediaFilesKept: number;
  /** Distinct `ci.content` rows its attachment pass created over them. */
  readonly attachmentContentsKept: number;
}

/** What retiring one run settled in `staged_sources`, alongside its payload. */
export interface RunRetirement {
  /** `staged_items` + `staged_entities`; relationships and mappings cascaded. */
  readonly stagedRowsDeleted: number;
  /** `staged_sources` rows deleted with the run — the ones SET NULL would have orphaned. */
  readonly sourceRowsDeleted: number;
  /** Claimed uploads handed back to the uploads list rather than deleted. */
  readonly uploadsRestaged: number;
}

/**
 * What a discard took — and, in the three "kept" counters, what it deliberately
 * did not. There is no undo, so the reply itemises the loss rather than
 * answering `{ discarded: true }`, and it itemises the SURVIVALS for the same
 * reason: "discarded" alone would let a user believe an import they threw away
 * left nothing behind, when the archive may be back in their uploads and the
 * photos it already stored are still in their memory.
 */
export interface DiscardedRun extends RunRetirement, MediaAlreadyStored {
  readonly runId: string;
  readonly label: string | null;
}

/**
 * Why a run that still owns a scratch tree is never retired, by the sweep or by
 * a discard. One string, because it is one rule.
 */
const SCRATCH_TREE_REASON =
  'The run still owns a scratch tree, so its row is the only index into those bytes. ' +
  'Reclaim or move the tree before this run can be retired.';

/**
 * Why a run holding unstored media is never retired either. Same shape and same
 * reason as {@link SCRATCH_TREE_REASON}: deleting a staged media row is what
 * makes {@link unstoredMediaExistsSql} answer `false` forever after, and that
 * answer is the only thing standing between a photo that exists solely on disk
 * and the reclaim that deletes the disk copy.
 */
const UNSTORED_MEDIA_REASON =
  'Staged media rows still name bytes that nothing has stored, so those rows are the only record ' +
  'that the files exist. Run the media stage for this run before it can be retired.';

/**
 * What a half-finished discard leaves on the run row.
 *
 * The stamp is `cancelled` because that is the one status
 * {@link pushableRunSql} refuses outright, so writing it takes the run off the
 * Sync card in the same statement that decides to delete it — see
 * {@link ImportRetentionService.claimForDiscard}.
 */
const DISCARD_CLAIM_ERROR =
  'Discarded by its owner; its staging is being reclaimed. Nothing here can be pushed.';

export interface RetentionSweepResult {
  /** Runs whose `staged_*` payload was deleted but whose history was kept. */
  readonly payloadPurgedRuns: number;
  /** Staged rows deleted by the payload sweep and the history sweep together. */
  readonly stagedRowsDeleted: number;
  /** `import_runs` rows deleted (each cascading its stages and any remainder). */
  readonly runsDeleted: number;
  /** `staged_sources` rows retired with those runs — the ones SET NULL would have orphaned. */
  readonly sourceRowsDeleted: number;
  /** Archives the retired runs were still holding, returned to their owner's uploads list. */
  readonly uploadsRestaged: number;
  /** Runs the sweep declined to touch, keyed by the reason it declined. */
  readonly skipped: Readonly<Record<string, number>>;
}

/**
 * Bound `ci_import`.
 *
 * ### The gap this closes
 *
 * `staged_items` / `staged_entities` / `staged_relationships` all reference
 * `import_runs(id) ON DELETE CASCADE`, and the schema header calls staging "a
 * scratchpad for one run, not a second copy of the user's data". Nothing
 * deleted a run outside tests: no cron, no `DELETE` route, no non-test
 * `DELETE FROM ci_import.*`. `StagedUploadPurgeCron` reclaims upload BYTES and
 * stamps their rows `expired` rather than removing them; completion-time
 * cleanup is filesystem-only
 * (`ImportStageListener` → `ImportScratchService.reclaim`). So every parsed
 * record's staging row — its metadata JSONB, its original location, its
 * content hash — outlived the `ci.*` row it produced, permanently, and the
 * only thing that removed it was deleting the user's account.
 *
 * ### Two windows, because staging and history are not the same thing
 *
 * Measured on a dev appliance that imported one real Google Takeout three
 * times: `ci_import` 1678 MB against ci.*'s 1274 MB — the scratchpad was
 * larger than the durable data it produced, and 56% of the database.
 * `staged_items` was 1578 MB over 1.94M rows (852 bytes per parsed record with
 * indexes; one 780,946-item run ≈ 640 MB). `import_runs` + `import_stages` for
 * the same 24 runs: 240 kB total.
 *
 * The import UI reads the cheap half and never the expensive one — the run
 * list, the stage bar, `import_stages.detail->>'pushed'` for the record count
 * (`ImportRunService.recordsFor`), `declared_sources` for the picker's
 * "imported ✓". Not one of those touches a `staged_*` row. So history can
 * survive the payload it describes, and the two get windows three orders of
 * magnitude apart in cost: `stagingDays` (7) for the scratchpad,
 * `runHistoryDays` (90) for the audit trail.
 *
 * ### What is never taken
 *
 * The TTL is the disk dial. The safety is the eligibility predicate, and it
 * holds at any TTL, including 0:
 *
 *  - **Nothing in flight.** Terminal status, `finished_at` set and older than
 *    the cutoff, `updated_at` older than the cutoff, and NO stage in `queued`
 *    or `running`. The status column is a cache; the stage rows are the truth.
 *  - **Nothing resumable.** A run with any `pending` staged row is what the
 *    Sync card offers and `startPush` acts on; a run with any `failed` staged
 *    row is what `ImportRunService.retryFailedPush` exists for. Either
 *    one keeps its payload — deleting it would turn a recoverable import into
 *    a silent no-op. A `failed`-row run still reclaims, whole, at
 *    `runHistoryDays`; a still-pushable one never does, per below.
 *  - **Nothing whose bytes are only on disk.** The unstored-media invariant
 *    (`unstoredMediaExistsSql`, shared verbatim with
 *    `ImportRunService.hasUnstoredMedia`) is what stops a scratch tree being
 *    reclaimed while a staged media row's photo lives only inside it.
 *    Deleting that row would answer the question `false` forever after, which
 *    is how the bytes get destroyed. Both candidate queries exclude such runs,
 *    and the sweep reports them by count so a pinned-open run is a signal
 *    rather than an absence.
 *  - **Nothing that still has a scratch tree.** `ImportStageListener`
 *    deliberately KEEPS the tree for a run that staged no records — for an
 *    inbox unit that tree is the user's only copy, acquired by rename. The
 *    tree's path is `<scratchDir>/<userId>/<runId>`, so the run row is the
 *    only index into it: delete the row and the archive is unattributable
 *    forever. Both passes skip such runs and log the directory.
 *  - **No source row's bytes, ever.** A retirement takes the retired run's
 *    spent `staged_sources` rows — `ON DELETE SET NULL` would otherwise orphan
 *    one per completed run forever — but an upload whose archive is sitting in
 *    the uploads directory this second is handed back to its owner rather than
 *    deleted, and the only sweep that removes staged bytes is still the TTL
 *    purge. See {@link ImportRetentionService.retireRun}.
 *
 * ### The one thing age alone never takes
 *
 * A run that PARSED but was never PUSHED is kept whole, forever, at any TTL.
 * `ImportRunService.pushableRunSql` is the Sync card's offer; the history sweep
 * negates that same expression, so the two can never disagree about whether a
 * payload is still wanted.
 *
 * This is a deliberate unbounded exception, not an omission, and the reasoning
 * is that by the time the history window elapses those staged rows are the ONLY
 * copy of the parse: the scratch tree was reclaimed at completion and the
 * uploaded archive was purged at 24h by `StagedUploadPurgeCron`. The two
 * alternatives are both worse. Deleting the payload leaves the Sync card
 * offering a push over nothing — a live button in front of destroyed data.
 * Expiring the OFFER at the same age silently discards a finished parse the
 * user could still complete for free, which is the same data loss with a
 * tidier UI.
 *
 * So the payload waits for a decision only a person can make (push it, or
 * delete the run), and every sweep reports it under `push_pending` so an
 * exception that never expires is at least never invisible.
 *
 * {@link ImportRetentionService.discardRun} is the second of those two
 * decisions, and the reason the exception is bounded by something. Until it
 * existed the skip named an action nobody could take: Sync was the only route
 * out, so a 780k-item parse the user had changed their mind about (≈640 MB)
 * was immortal unless they pushed data they did not want. Age still never
 * takes such a run — that half is unchanged, and must be, because the age of a
 * parse says nothing about whether its owner still wants it.
 *
 * Deletes are batched per run rather than issued as one statement, because one
 * statement here is a 780k-row transaction on the appliance's only database.
 * The cost of that is that no single run's retirement is atomic, so each caller
 * has to make a half-finished delete harmless in its own way — see
 * {@link ImportRetentionService.retire}.
 */
@Injectable()
export class ImportRetentionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly scratch: ImportScratchService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ImportRetentionService.name);
  }

  /**
   * One nightly pass: reclaim drained payload, then expire old history.
   *
   * Payload first. A run old enough for both windows has its `staged_*` rows
   * deleted in bounded batches by the first pass, so the `DELETE` the second
   * pass issues against `import_runs` cascades over almost nothing.
   */
  async sweep(now: Date = new Date()): Promise<RetentionSweepResult> {
    const { enabled, stagingDays, runHistoryDays, maxRunsPerSweep } = config.import.retention;

    if (!enabled) {
      return {
        payloadPurgedRuns: 0,
        stagedRowsDeleted: 0,
        runsDeleted: 0,
        sourceRowsDeleted: 0,
        uploadsRestaged: 0,
        skipped: {},
      };
    }

    const skipped: Record<string, number> = {};
    const skip = (reason: string, candidate: RetentionCandidate, detail?: object): void => {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
      this.logger.warn('Import retention skipped a run', {
        reason,
        runId: candidate.id,
        userId: candidate.userId,
        label: candidate.label,
        ...detail,
      });
    };

    let stagedRowsDeleted = 0;
    let payloadPurgedRuns = 0;

    // Before anything is deleted, say what CANNOT be. A run whose media never
    // reached MediaStage is pinned open until someone runs it, and it is
    // excluded from both candidate queries — so without this it would be
    // silently absent from the sweep forever rather than reported as stuck.
    for (const candidate of await this.mediaBlockedRuns(cutoff(now, stagingDays), maxRunsPerSweep)) {
      skip('unstored_media', candidate, {
        message:
          'Staged media rows still carry bytes that only exist in this run’s scratch tree, so its ' +
          'staging cannot be reclaimed. Run the media stage for this run.',
      });
    }

    for (const candidate of await this.drainedRuns(cutoff(now, stagingDays), maxRunsPerSweep)) {
      const blocked = await this.blockedByBytes(candidate, skip);

      if (blocked) {
        continue;
      }

      const deleted = await this.deletePayload(candidate.id);

      stagedRowsDeleted += deleted;
      payloadPurgedRuns += 1;

      this.logger.log('Reclaimed import staging for a drained run', {
        runId: candidate.id,
        userId: candidate.userId,
        label: candidate.label,
        status: candidate.status,
        finishedAt: candidate.finishedAt,
        stagedRowsDeleted: deleted,
      });
    }

    let runsDeleted = 0;
    let sourceRowsDeleted = 0;
    let uploadsRestaged = 0;
    const historyCutoff = cutoff(now, runHistoryDays);

    // Same reason as the media report above: these runs are kept FOREVER, and
    // an exception nobody can see is one nobody will ever resolve.
    for (const candidate of await this.pushableRuns(historyCutoff, maxRunsPerSweep)) {
      skip('push_pending', candidate, {
        message:
          'This run parsed but was never pushed, so its staged rows are the only copy of that parse ' +
          'and the Sync card is still offering them. Nothing deletes a run on the user’s behalf: ' +
          'Sync it, or discard it (DELETE /import/runs/:runId).',
      });
    }

    for (const candidate of await this.expiredRuns(historyCutoff, maxRunsPerSweep)) {
      const blocked = await this.blockedByBytes(candidate, skip);

      if (blocked) {
        continue;
      }

      // Whatever the payload sweep declined to take (a run that kept `failed`
      // rows for a retry nobody ran) goes now, in the same bounded batches, so
      // the run delete itself cascades over an empty tail.
      const retired = await this.retire(candidate.id);

      stagedRowsDeleted += retired.stagedRowsDeleted;
      sourceRowsDeleted += retired.sourceRowsDeleted;
      uploadsRestaged += retired.uploadsRestaged;
      runsDeleted += 1;

      this.logger.log('Expired an import run past the history window', {
        runId: candidate.id,
        userId: candidate.userId,
        label: candidate.label,
        status: candidate.status,
        finishedAt: candidate.finishedAt,
        sourceRowsDeleted: retired.sourceRowsDeleted,
        uploadsRestaged: retired.uploadsRestaged,
      });
    }

    if (payloadPurgedRuns > 0 || runsDeleted > 0 || Object.keys(skipped).length > 0) {
      this.logger.log('Import retention sweep finished', {
        payloadPurgedRuns,
        stagedRowsDeleted,
        runsDeleted,
        sourceRowsDeleted,
        uploadsRestaged,
        skipped,
        stagingDays,
        runHistoryDays,
      });
    }

    return {
      payloadPurgedRuns,
      stagedRowsDeleted,
      runsDeleted,
      sourceRowsDeleted,
      uploadsRestaged,
      skipped,
    };
  }

  /**
   * Throw away one abandoned parse, at its owner's request.
   *
   * The action the `push_pending` skip has always pointed at. Everything that
   * skip protects is still true — those staged rows are the only surviving copy
   * of the parse — so the one thing that can safely resolve it is the owner
   * saying they do not want it. This is that sentence, and it is irreversible:
   * `staged_items`, `staged_entities`, their relationships and entity mappings,
   * the stage rows and the run row all go, and its `staged_sources` rows are
   * settled by {@link ImportRetentionService.retireRun} — which is why an
   * archive the user still holds comes BACK to their uploads list rather than
   * going with the parse. Discarding a parse is not the same as discarding the
   * export it was made from, and the reply says which happened.
   *
   * ### What it will not discard
   *
   * Deliberately NOT "any terminal run". The retention sweep already collects
   * every other terminal run at `runHistoryDays`, so a general delete would add
   * no reclaim and three new ways to lose data — history the user reads
   * (`records`, `declared_sources`, the stage bar) can be destroyed by a
   * misfire, a run mid-flight can be pulled out from under a worker, and a run
   * whose bytes are only on disk can be unindexed. The immortal run is the ONLY
   * one that has no other route out, so it is the only one this takes:
   *
   *  - **The user's own run**, scoped in the WHERE clause. Someone else's run is
   *    `null` — a 404 at the edge — not a refusal that confirms it exists.
   *  - **Pushable**, by {@link pushableRunSql} — the same expression the Sync
   *    card offers and the history sweep negates, evaluated here for a third
   *    time rather than restated. A run that is not pushable is refused with
   *    the reason: retention already collects it.
   *  - **Quiet**, by the stage rows rather than the status cache. A run with a
   *    `queued` or `running` stage is refused and told to cancel first;
   *    deleting a run a worker still holds would leave that worker writing to
   *    rows that no longer exist.
   *  - **Not holding bytes on disk**, by {@link SCRATCH_TREE_REASON} and by
   *    {@link UNSTORED_MEDIA_REASON}. In practice a pushable run has neither —
   *    `ImportStageListener` keeps a tree only for a run that staged NO records,
   *    and it keeps one for unstored media too — but BOTH guards are applied
   *    here rather than inherited from that listener's behaviour. The sweep
   *    states the unstored-media rule in SQL in all four of its candidate
   *    queries; a discard that stated it nowhere would be safe only for as long
   *    as a filesystem stat in another component happened to agree, and would
   *    become the one path that deletes the rows proving a photo exists only on
   *    disk the moment that stopped being true.
   *
   * ### What it does NOT undo: media this run already stored
   *
   * The wizard runs `unpack, parse, media` before the Sync card ever lists a
   * run, so by the time a discard is possible `MediaStage` has already put every
   * photo, video and voicemail into `ci.files` (bytes in the object store) and
   * every message attachment it catalogues into `ci.content`. Those rows are
   * `ci.*`, not `ci_import.*`: no cascade reaches them, and the only thing that
   * still NAMES them is `staged_items.metadata.FileId` / `AttachmentFileIds` /
   * `AttachmentContentIds` — which this deletes.
   *
   * They are counted before the delete and reported ({@link MediaAlreadyStored})
   * rather than taken, and that is a decision rather than an omission.
   * `FileService.uploadWithDedupInfo` resolves identical bytes onto the
   * EXISTING file row, and `ContentService.createManyDetailed` dedupes on the
   * provenance triple, so an id in this run's metadata may name a file an
   * earlier — pushed — import created and that a live `ci.events` row points at
   * through `ci.content`. Nothing stored distinguishes the two cases after the
   * fact. Deleting on a guess would destroy a photo the user still has every
   * other reason to keep, which is strictly worse than keeping bytes they
   * expected to be gone; keeping them silently is worse than either, and is
   * what the counters exist to prevent.
   *
   * Note the asymmetry with the history sweep, which reports nothing of the
   * kind: the runs IT deletes were pushed, so their media is referenced by the
   * `ci.*` rows that push created and is not orphaned by the retirement at all.
   *
   * ### Crash safety
   *
   * The delete cannot be one transaction — the payload is up to 780k rows — so
   * the run is first CLAIMED in a small one that stamps it `cancelled`
   * ({@link ImportRetentionService.claimForDiscard}). Everything after that
   * point is batched and interruptible, and a crash halfway leaves an inert run
   * that no longer appears on the Sync card, rather than a still-pushable
   * half-parse whose Sync button would import a fragment of what the user asked
   * to destroy. The remains are an ordinary retention candidate from then on.
   *
   * Returns `null` when there is no such run for this user; throws
   * `ConflictException` when the run exists but is not the abandoned parse this
   * is for.
   */
  async discardRun(ctx: UserServiceContext, runId: string): Promise<DiscardedRun | null> {
    const candidate = await this.claimForDiscard(ctx.userId, runId);

    if (candidate == null) {
      return null;
    }

    // Counted BEFORE the payload goes. `staged_items.metadata` is the only
    // thing left that names those files, so once `deletePayload` has run the
    // question has no answer anywhere.
    const kept = await this.mediaAlreadyStored(candidate.id);
    const retired = await this.retire(candidate.id);

    // `warn`, not `log`: this is the one path that destroys a parse nothing else
    // would have taken, and the counts are the only record that it existed.
    this.logger.warn('Discarded an import run at its owner’s request', {
      runId: candidate.id,
      userId: candidate.userId,
      label: candidate.label,
      status: candidate.status,
      finishedAt: candidate.finishedAt,
      ...retired,
      ...kept,
    });

    return { runId: candidate.id, label: candidate.label, ...retired, ...kept };
  }

  /**
   * Take the run off the Sync card and out of every other caller's reach, or
   * refuse — in one transaction, holding the row lock the whole time.
   *
   * ### Why a lock and not one clever statement
   *
   * The eligibility answers and the delete are necessarily separate: the delete
   * is batched over up to 780k rows and cannot join the statement that decided
   * it. So the check/delete split is real, and the only question is what stops a
   * `Sync` click landing inside it. `ImportRunService.startPush` takes
   * `FOR UPDATE OF r` on `import_runs` inside its own append-and-reopen
   * statement, so taking the SAME row lock here is what serialises the two:
   * a push that has already committed is visible below and refused; one that
   * has not blocks until this transaction ends and then re-evaluates
   * `PUSH_ELIGIBLE_WHERE` against a run that is either gone or `cancelled`.
   *
   * The lock is taken by its own statement, and the predicates are read by the
   * NEXT one, deliberately. Under `READ COMMITTED` a `SELECT … FOR UPDATE` that
   * waits on a concurrent writer re-evaluates its own WHERE clause against the
   * updated row, but the sublinks in its target list still see the snapshot the
   * statement began with — so `pushable`, which is entirely sublinks over
   * `import_stages`, would be computed from a view of the world taken BEFORE
   * the push it needs to notice. A second statement takes a fresh snapshot,
   * with the lock already held, and cannot miss it.
   *
   * ### Why it stamps rather than just reading
   *
   * `cancelled` is the one status {@link pushableRunSql} rejects on its own, so
   * the stamp is what makes every guarantee above outlive this transaction: from
   * commit onwards the run is off the Sync card, `startPush` cannot select it,
   * and the history sweep will collect whatever a crash leaves behind. It is
   * written WITHOUT touching `finished_at` or `updated_at` so those remains age
   * on the run's original clock rather than restarting the history window.
   *
   * The scratch stat happens inside the transaction too. It is a `stat`, so it
   * costs microseconds, and doing it before the stamp is what keeps a refusal a
   * pure refusal — a run this declines is left exactly as it was found.
   */
  private async claimForDiscard(userId: string, runId: string): Promise<DiscardCandidate | null> {
    return this.dataSource.transaction(async (manager) => {
      const [locked] = await manager.query<Array<{ id: string }>>(
        `SELECT r.id
           FROM ci_import.import_runs r
          WHERE r.id = $1::uuid AND r.user_id = $2::uuid
            FOR UPDATE OF r`,
        [runId, userId],
      );

      if (locked == null) {
        return null;
      }

      const [candidate] = await manager.query<DiscardCandidate[]>(
        `SELECT r.id, r.user_id AS "userId", r.label, r.status, r.finished_at AS "finishedAt",
                ${pushableRunSql('r')} AS pushable,
                NOT ${liveStageExistsSql('r', '$2')} AS quiet,
                ${unstoredMediaExistsSql('r.id', '$3')} AS "unstoredMedia"
           FROM ci_import.import_runs r
          WHERE r.id = $1::uuid`,
        [runId, [...LIVE_STAGE_STATUSES], [...FILE_CLASSIFICATIONS]],
      );

      if (candidate.finishedAt == null || !candidate.quiet) {
        throw new ConflictException(
          `Import run ${runId} is still working. Cancel it first, then discard what it staged.`,
        );
      }

      if (!candidate.pushable) {
        throw new ConflictException(
          `Import run ${runId} has no parse waiting to be pushed, so there is nothing here for a discard ` +
            'to release. Retention collects this run on its own once it is past the history window.',
        );
      }

      if (candidate.unstoredMedia) {
        throw new ConflictException(`Import run ${runId}: ${UNSTORED_MEDIA_REASON}`);
      }

      if (await this.scratch.exists(candidate.userId, candidate.id)) {
        throw new ConflictException(
          `${SCRATCH_TREE_REASON} (${this.scratch.dirFor(candidate.userId, candidate.id)})`,
        );
      }

      await manager.query(
        `UPDATE ci_import.import_runs SET status = 'cancelled', error = $2 WHERE id = $1::uuid`,
        [runId, DISCARD_CLAIM_ERROR],
      );

      return candidate;
    });
  }

  /**
   * How much of the user's memory this run had already written before they
   * changed their mind — the numbers the reply owes them.
   *
   * Read off `staged_items.metadata`, which is where `MediaStage` records its
   * own output and the only place these ids survive: `FileId` per stored media
   * item, `AttachmentFileIds` / `AttachmentContentIds` per message that carried
   * attachments. DISTINCT because both are deliberately shared — the object
   * store resolves identical bytes onto one file row, so a `-edited` duplicate
   * and a WhatsApp photo staged twice both count once, which is what makes the
   * number mean "files in your memory" rather than "rows we touched".
   *
   * Every `jsonb_array_elements` is guarded by `jsonb_typeof(...) = 'array'` in
   * the same expression, not in the WHERE clause: a scalar in that key would
   * make the function throw before any filter could exclude the row.
   */
  private async mediaAlreadyStored(runId: string): Promise<MediaAlreadyStored> {
    const [row] = await this.dataSource.query<MediaAlreadyStored[]>(
      `WITH stored AS (
         SELECT s.metadata->>'FileId' AS file_id, NULL::text AS content_id
           FROM ci_import.staged_items s
          WHERE s.run_id = $1::uuid AND s.metadata->>'FileId' IS NOT NULL
         UNION ALL
         SELECT a #>> '{}' AS file_id, NULL::text AS content_id
           FROM ci_import.staged_items s
           CROSS JOIN LATERAL jsonb_array_elements(
                 CASE WHEN jsonb_typeof(s.metadata->'AttachmentFileIds') = 'array'
                      THEN s.metadata->'AttachmentFileIds' ELSE '[]'::jsonb END) a
          WHERE s.run_id = $1::uuid
         UNION ALL
         SELECT NULL::text AS file_id, c #>> '{}' AS content_id
           FROM ci_import.staged_items s
           CROSS JOIN LATERAL jsonb_array_elements(
                 CASE WHEN jsonb_typeof(s.metadata->'AttachmentContentIds') = 'array'
                      THEN s.metadata->'AttachmentContentIds' ELSE '[]'::jsonb END) c
          WHERE s.run_id = $1::uuid
       )
       SELECT count(DISTINCT file_id)::int AS "mediaFilesKept",
              count(DISTINCT content_id)::int AS "attachmentContentsKept"
         FROM stored`,
      [runId],
    );

    return row ?? { mediaFilesKept: 0, attachmentContentsKept: 0 };
  }

  /**
   * Empty a run's payload, then delete the run itself.
   *
   * The history sweep's per-run body, extracted because
   * {@link ImportRetentionService.discardRun} must do exactly the same thing —
   * a second delete path would be a second chance to forget the batching, or
   * the `staged_sources` half, or the transaction the two source deletes need.
   * The payload goes first so the `DELETE` on `import_runs` cascades over an
   * empty tail rather than issuing one 780k-row statement.
   *
   * NOT atomic, and cannot be: `deletePayload` commits a batch at a time. Both
   * callers are responsible for making a half-finished run harmless before they
   * get here, and they do it differently because their preconditions differ —
   * the sweep's candidates are non-pushable by construction, so a partial delete
   * leaves rows nothing was offering to push, while a discard's candidate is
   * pushable by definition and is stamped `cancelled` first for exactly that
   * reason ({@link ImportRetentionService.claimForDiscard}).
   */
  private async retire(runId: string): Promise<RunRetirement> {
    const stagedRowsDeleted = await this.deletePayload(runId);
    const { sourceRowsDeleted, uploadsRestaged } = await this.retireRun(runId);

    return { stagedRowsDeleted, sourceRowsDeleted, uploadsRestaged };
  }

  /**
   * Delete a run and settle every `staged_sources` row that named it.
   *
   * `import_runs` cascades to `import_stages` and every `staged_*` table, but
   * `staged_sources.run_id` is `ON DELETE SET NULL` — so the history sweep used
   * to blank the run id and leave the registry row standing. Nothing collects
   * one afterwards: `releaseUpload` is a user action, `purgeExpired` reads
   * `origin = 'upload' AND status = 'staged'`, and `sweepUploadOrphans`
   * reclaims BYTES from the uploads directory, never rows. One row per
   * completed run and one per released inbox claim therefore accumulated with
   * no upper bound, which is the half of "bound `ci_import`" the run delete
   * alone did not meet.
   *
   * CASCADE would be the wrong repair — it is what stops a run delete taking
   * the registry row of bytes that still exist — so this is a predicate rather
   * than a constraint change, and it answers per row:
   *
   *  - the spent statuses ({@link SOURCE_STATUSES_SPENT_WITH_RUN}) name no
   *    bytes of their own and go with the run;
   *  - an INBOX `claimed` row is only a claim on a file that never left the
   *    user's own folder, so it goes too, and the path it held in
   *    `staged_sources_active_path_uq` is claimable again. Left behind, that
   *    inbox unit could never be imported by anyone again;
   *  - an UPLOAD `claimed` row names an archive sitting in the uploads
   *    directory right now, so it is handed BACK: `staged`, no run, a fresh
   *    TTL — exactly what `StagedSourceService.release` does for a run that
   *    ends without consuming. The user sees it in their uploads list again and
   *    can re-import it under the same dropId; if they do not, the TTL purge
   *    reclaims the bytes on its own. Deleting the row instead would strand the
   *    archive, and expiring it would make retention the one sweep that
   *    destroys bytes nobody asked it to.
   *
   * The re-stage runs BEFORE the run delete: SET NULL fires the moment the run
   * goes, and `run_id` is the only thing left that identifies these rows.
   *
   * All of it in one transaction, for the same reason — a source row whose run
   * vanished between two statements has already lost the only handle on it.
   *
   * The CALLER is what guarantees the run is finished and quiet: the sweep by
   * its candidate predicate, {@link ImportRetentionService.discardRun} by its
   * refusals. Re-staging an upload a live unpack is about to move would hand
   * the same bytes to a second run.
   */
  private async retireRun(runId: string): Promise<Omit<RunRetirement, 'stagedRowsDeleted'>> {
    const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS);

    return this.dataSource.transaction(async (manager) => {
      // CTE-wrapped so the outer command is a SELECT, for the same driver
      // reason as `deleteBatched` below.
      const [restaged] = await manager.query<Array<{ restaged: number }>>(
        `WITH back AS (
           UPDATE ci_import.staged_sources
              SET status = 'staged', run_id = NULL, claimed_at = NULL,
                  expires_at = $2::timestamptz, updated_at = now()
            WHERE run_id = $1::uuid AND origin = 'upload' AND status = 'claimed'
          RETURNING id
         )
         SELECT count(*)::int AS restaged FROM back`,
        [runId, expiresAt],
      );

      const [gone] = await manager.query<Array<{ deleted: number }>>(
        `WITH gone AS (
           DELETE FROM ci_import.staged_sources
            WHERE run_id = $1::uuid
              AND (status = ANY($2::text[]) OR (origin = 'inbox' AND status = 'claimed'))
          RETURNING id
         )
         SELECT count(*)::int AS deleted FROM gone`,
        [runId, [...SOURCE_STATUSES_SPENT_WITH_RUN]],
      );

      await manager.query(`DELETE FROM ci_import.import_runs WHERE id = $1::uuid`, [runId]);

      return { sourceRowsDeleted: gone?.deleted ?? 0, uploadsRestaged: restaged?.restaged ?? 0 };
    });
  }

  /**
   * The one guard SQL cannot express: does this run still own a scratch tree?
   *
   * `stat`, not a query, which is why it is here and not in the candidate
   * predicate — and why it is the one skip that can consume a sweep's budget.
   * Acceptable because it is rare and loud: `ImportStageListener` keeps a tree
   * only for a run that staged no records, and every such run logs a warning
   * naming the directory. The unstored-media case, which is neither rare nor
   * self-clearing, is filtered in SQL instead.
   *
   * Returns true when the run must be left alone.
   */
  private async blockedByBytes(
    candidate: RetentionCandidate,
    skip: (reason: string, candidate: RetentionCandidate, detail?: object) => void,
  ): Promise<boolean> {
    if (await this.scratch.exists(candidate.userId, candidate.id)) {
      skip('scratch_tree_present', candidate, {
        scratchDir: this.scratch.dirFor(candidate.userId, candidate.id),
        message: SCRATCH_TREE_REASON,
      });

      return true;
    }

    return false;
  }

  /**
   * Terminal runs, past the staging window, with a payload and nothing left to
   * do with it.
   *
   * `updated_at` is checked alongside `finished_at` so a run touched recently
   * for any reason — a rollup refresh, a reopen that lost its race — falls out
   * of the window it would otherwise sit inside.
   *
   * The unstored-media guard is applied HERE, inside the query, rather than in
   * TypeScript after the fact. A run whose media never reached `MediaStage` is
   * blocked until an operator acts, and — being old — it sorts to the FRONT of
   * this queue: filtering it after the `LIMIT` would let one stuck run consume
   * every sweep's budget and silently starve every run behind it.
   * {@link ImportRetentionService.mediaBlockedRuns} reports them separately so
   * excluding them here does not also make them invisible.
   */
  private async drainedRuns(cutoffAt: Date, limit: number): Promise<RetentionCandidate[]> {
    return this.selectRuns(
      `${TERMINAL_AND_QUIET}
       AND (EXISTS (SELECT 1 FROM ci_import.staged_items i WHERE i.run_id = r.id)
         OR EXISTS (SELECT 1 FROM ci_import.staged_entities e WHERE e.run_id = r.id))
       AND NOT EXISTS (
             SELECT 1 FROM ci_import.staged_items i
              WHERE i.run_id = r.id AND i.push_status IN ('pending', 'failed'))
       AND NOT EXISTS (
             SELECT 1 FROM ci_import.staged_entities e
              WHERE e.run_id = r.id AND e.push_status IN ('pending', 'failed'))
       AND NOT ${unstoredMediaExistsSql('r.id', '$5')}`,
      cutoffAt,
      limit,
    );
  }

  /**
   * Terminal runs past the history window.
   *
   * The backstop: a run that kept `failed` staged rows for a retry that never
   * came is exactly what it is for — that payload is reachable only through
   * `retryFailedPush`, which the user has had the whole window to click.
   *
   * But NOT a run whose payload is still PUSHABLE. `NOT pushableRunSql` is the
   * exact complement of what the Sync card offers, shared verbatim with it, so
   * this sweep cannot delete rows the card is still promising to push — see the
   * "never collected at all" note on the class.
   */
  private async expiredRuns(cutoffAt: Date, limit: number): Promise<RetentionCandidate[]> {
    return this.selectRuns(
      `${TERMINAL_AND_QUIET}
       AND NOT ${pushableRunSql('r')}
       AND NOT ${unstoredMediaExistsSql('r.id', '$5')}`,
      cutoffAt,
      limit,
    );
  }

  /**
   * Terminal runs past the history window that {@link expiredRuns} refuses
   * because their parse has never been pushed. The complement of the guard it
   * applies — reported, by the same rule as the media-blocked runs, so an
   * unbounded exception is a standing signal rather than a silent absence.
   */
  private async pushableRuns(cutoffAt: Date, limit: number): Promise<RetentionCandidate[]> {
    return this.selectRuns(
      `${TERMINAL_AND_QUIET}
       AND ${pushableRunSql('r')}
       AND NOT ${unstoredMediaExistsSql('r.id', '$5')}`,
      cutoffAt,
      limit,
    );
  }

  /**
   * Terminal runs past the staging window that BOTH sweeps refuse, because
   * their staged media rows are the only record of bytes sitting in a scratch
   * tree. The complement of the guard both candidate queries apply — reported
   * so a stuck run is a signal rather than an absence.
   */
  private async mediaBlockedRuns(cutoffAt: Date, limit: number): Promise<RetentionCandidate[]> {
    return this.selectRuns(
      `${TERMINAL_AND_QUIET} AND ${unstoredMediaExistsSql('r.id', '$5')}`,
      cutoffAt,
      limit,
    );
  }

  /**
   * Every caller's `where` must reference all five parameters — Postgres
   * rejects a bind list longer than the statement's highest `$n`, so `$5` (the
   * file classifications) is not optional here. That is a constraint worth
   * having: it is what stops a new sweep being added that forgets the
   * unstored-media guard.
   */
  private async selectRuns(where: string, cutoffAt: Date, limit: number): Promise<RetentionCandidate[]> {
    const rows = await this.dataSource.query<
      Array<{ id: string; userId: string; label: string | null; status: string; finishedAt: Date | null }>
    >(
      `SELECT r.id, r.user_id AS "userId", r.label, r.status, r.finished_at AS "finishedAt"
         FROM ci_import.import_runs r
        WHERE ${where}
        ORDER BY r.finished_at ASC
        LIMIT $4`,
      [cutoffAt, [...TERMINAL_RUN_STATUSES], [...LIVE_STAGE_STATUSES], limit, [...FILE_CLASSIFICATIONS]],
    );

    return rows;
  }

  /**
   * Delete one run's staged rows in bounded batches.
   *
   * Items before entities: `staged_relationships` cascades from both, and
   * `entity_mappings` from `staged_entities`, so emptying items first leaves
   * the entity pass with the smallest possible fan-out.
   *
   * The table name is interpolated because it is a literal from
   * {@link PAYLOAD_TABLES} and Postgres takes no parameter in that position;
   * the run id and the batch size are bound. The statement is CTE-wrapped so
   * the outer command is a SELECT — a bare `DELETE … RETURNING` resolves as
   * `[rows, rowCount]` through this driver, the same reason every write in
   * `ImportRunService` is shaped this way.
   */
  private async deletePayload(runId: string): Promise<number> {
    let total = 0;

    for (const table of PAYLOAD_TABLES) {
      total += await this.deleteBatched(table, runId);
    }

    return total;
  }

  private async deleteBatched(table: PayloadTable, runId: string): Promise<number> {
    const batchSize = config.import.retention.deleteBatchSize;
    let total = 0;

    for (;;) {
      const [row] = await this.dataSource.query<Array<{ deleted: number }>>(
        `WITH doomed AS (
           SELECT id FROM ci_import.${table} WHERE run_id = $1::uuid LIMIT $2
         ), gone AS (
           DELETE FROM ci_import.${table} t USING doomed d WHERE t.id = d.id RETURNING t.id
         )
         SELECT count(*)::int AS deleted FROM gone`,
        [runId, batchSize],
      );

      const deleted = row?.deleted ?? 0;

      total += deleted;

      if (deleted < batchSize) {
        return total;
      }
    }
  }
}

/**
 * `$1` = cutoff, `$2` = terminal statuses, `$3` = live stage statuses.
 *
 * Shared VERBATIM by both sweeps so the payload window and the history window
 * can never disagree about what "finished" means — the same reason
 * `PUSH_ELIGIBLE_WHERE` is one constant in `ImportRunService`.
 */
const TERMINAL_AND_QUIET = `
      r.status = ANY($2::text[])
  AND r.finished_at IS NOT NULL
  AND r.finished_at < $1::timestamptz
  AND r.updated_at < $1::timestamptz
  AND NOT ${liveStageExistsSql('r', '$3')}`;

/**
 * "This run still has a stage with work ahead of it": one `running`, or one
 * `queued` while the run itself is still open. `statusesParam` holds
 * {@link LIVE_STAGE_STATUSES}.
 *
 * A `queued` stage in a FINISHED run is a leftover, not work. `failStage`
 * closes the run when a stage fails and leaves the stages after it `queued`,
 * which is what lets `retryStage` carry the import on from there (it reopens
 * the run along with the stage it requeues). Counting those leftovers as live
 * made a run whose unpack failed refuse a discard as "still working" while
 * cancel answered "not in flight", and kept it out of both sweeps for good.
 * `ImportRunService.retryFailedPush` already reads them the same way.
 */
function liveStageExistsSql(runRef: string, statusesParam: string): string {
  return `EXISTS (
        SELECT 1 FROM ci_import.import_stages s
         WHERE s.run_id = ${runRef}.id
           AND s.status = ANY(${statusesParam}::text[])
           AND (s.status <> 'queued' OR ${runRef}.finished_at IS NULL))`;
}

function cutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
