import path from 'node:path';

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';

import {
  dataSourcesRecognize,
  isPathWithinOrEqual,
  type DataSourceRecognition,
  type DirEntry,
} from '../datasources/registry';
import { COLLAPSED_DISTINCT_PATH, StagedWriter, type StagedCounts } from '../staging/StagedWriter';
import { describeStageFailure, withStageContext } from '../telemetry/stageError';
import { buildStageSummary, SUMMARY_KEY, type StageUnitInput } from '../telemetry/stageSummary';
import type { ImportStageRunner, StageOutcome, StageRunContext } from '../types';

/**
 * Read the unpacked tree and stage what is in it.
 *
 * Recognition first, then one parser per recognized source. A Google Takeout is
 * not "a Takeout" to the importer — it is Mail, Photos, Location History and
 * Chrome history sitting in one folder, each with its own parser, and each
 * staging under its own `data_source` so the push and every downstream dedup can
 * tell them apart.
 *
 * ## One bad parser does not fail the import
 *
 * A parser that throws is caught, recorded against its source, and the stage
 * moves to the next one. The run ends `partial` — terminal, success-ish — with
 * the failures in the stage detail. Five of six sources imported is five more
 * than a run that aborted on the first exception, and the alternative teaches
 * people to re-upload 40GB because one parser met a file it disliked.
 */
/** The catch-all importer's registered name (datasources/generic.ts). */
const GENERIC_DATA_SOURCE = 'generic';

/**
 * How often a long-running source's staged count is sampled.
 *
 * Below the listener's 1s progress throttle would only produce writes it
 * discards; far above it makes the counter visibly jerky. 2s reads as live.
 */
const PROGRESS_SAMPLE_MS = 2_000;

@Injectable()
export class ParseStage implements ImportStageRunner {
  readonly kind = 'parse' as const;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ParseStage.name);
  }

  async run(context: StageRunContext): Promise<StageOutcome> {
    await context.progress({ processed: 0, total: null, phase: 'recognizing' });

    const recognized = await this.recognize(context, context.scratchDir);

    if (recognized.length === 0) {
      // Not an error. A person can upload something this appliance has no parser
      // for, and the honest report is "nothing here I know how to read" rather
      // than a failure that implies their file was broken.
      return {
        processed: 0,
        total: 0,
        partial: true,
        detail: {
          recognized: [],
          reason: 'no recognized data sources in the uploaded tree',
          [SUMMARY_KEY]: buildStageSummary({
            stage: 'parse',
            unitKind: 'data_source',
            units: [],
            zeroInputReason: 'no_input',
          }),
        },
      };
    }

    const perSource: Array<Record<string, unknown>> = [];
    const failures: Array<{ dataSource: string; error: string }> = [];
    const units: StageUnitInput[] = [];
    let staged = 0;

    for (const [index, match] of recognized.entries()) {
      const name = match.data_source.name;
      const matchedPath = match.matchedPath ?? context.scratchDir;
      // Relative to the run's scratch tree. The absolute form is an appliance
      // path with a run uuid in it — noise in an error line, and it names a
      // directory that is reclaimed the moment the run ends.
      const where = path.relative(context.scratchDir, matchedPath) || '.';
      const phase = `parsing ${name} (${index + 1}/${recognized.length})`;

      await context.progress({ processed: staged, total: null, phase });

      // Counts are read off the writer whether the parser returned or threw. A
      // parser that staged 300,000 rows and then met one unreadable file used
      // to report NOTHING for this source — the throw skipped the `perSource`
      // push entirely — so a run's biggest source could vanish from its own
      // report while its rows sat in `staged_items`. The rows are real either
      // way; the ledger must say so.
      const writer = this.writerFor(context, name);
      let error: string | null = null;

      try {
        // Both halves matter here. `withStageContext` is this branch's telemetry
        // frame; the `report` callback is main's live-progress sampler, which
        // keeps `processed` moving during the hour a 73k-file source parses.
        // The writer stays hoisted (see above) so its counts survive a throw.
        await withStageContext({ stage: 'parse', phase, dataSource: name, file: where }, () =>
          this.parseOne(context, match, writer, (live) =>
            context.progress({
              processed: staged + live,
              total: null,
              phase,
            }),
          ),
        );
      } catch (err) {
        error = describeStageFailure(err, { stage: 'parse', phase });

        failures.push({ dataSource: name, error });
        this.logger.warn('Parser failed; continuing with the other sources', {
          runId: context.runId,
          dataSource: name,
          matchedPath: where,
          error,
        });
      }

      const counts = writer.totals;

      staged += counts.items + counts.entities;
      perSource.push({ dataSource: name, ...counts, ...(error != null ? { error } : {}) });
      units.push(parseUnit(name, where, counts, error));
    }

    await this.recordDataSources(context.runId, perSource);

    return {
      processed: staged,
      total: staged,
      partial: failures.length > 0,
      detail: {
        recognized: recognized.map((match) => match.data_source.name),
        sources: perSource,
        failures,
        // Additive. `recognized` and `sources` are read by ImportRunsController
        // and the web RunPipeline and keep their exact shape; this is the
        // aggregated, reconciled view — 13 units instead of the Takeout's 56
        // unordered entries, each saying what it consumed, produced and lost.
        [SUMMARY_KEY]: buildStageSummary({
          stage: 'parse',
          unitKind: 'data_source',
          units,
          // Every unit in this list WAS attempted: it is here because
          // recognition matched it and this loop ran its parser. So a zero is
          // never "no input" — it is a parser that read its match and found
          // nothing, which is the case that used to look identical to a parser
          // that never ran. On the QA corpus that was 9 of 56 entries,
          // including `google_photos` inside a real Google Takeout.
          zeroInputReason: 'recognized_not_read',
        }),
      },
    };
  }

  /** The writer one source stages through. Held by `run` so a throw cannot lose its counts. */
  private writerFor(context: StageRunContext, dataSource: string): StagedWriter {
    return new StagedWriter(this.dataSource.manager, {
      userId: context.userId,
      runId: context.runId,
      dataSource,
    });
  }

  /**
   * Stamp the run with the services it turned out to contain, via
   * {@link rankDataSources}.
   *
   * On the run itself rather than left in this stage's `detail`, because the run
   * LIST is what needs it — naming a run in a list of ten should not mean
   * joining ten stage rows and parsing their JSON.
   *
   * Ordered by row count, so the first name is the one the archive is mostly
   * about; a `generic` fallback that matched a stray CSV sorts to the end
   * instead of leading. Ties break on name so a re-parse is stable.
   *
   * Sources that produced NOTHING are dropped: a parser recognising a file and
   * then finding no rows in it is not something the run was.
   */
  private async recordDataSources(
    runId: string,
    perSource: ReadonlyArray<Record<string, unknown>>,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE ci_import.import_runs SET data_sources = $2::text[] WHERE id = $1::uuid`,
      [runId, rankDataSources(perSource)],
    );
  }

  /**
   * Which importers claim anything under the run's tree.
   *
   * `descend: true` because the tree is whatever the archive contained: a bare
   * `.gpx` sitting one level down is the single-file drag-and-drop case, and
   * without descent the containing folder matches nothing at all.
   *
   * Recognition ticks its progress per entry scanned. It is normally
   * sub-second, but it is also thousands of tiny reads — and when the disk is
   * busy (a neighbouring run's 350GB unpack) those crawl, and a real LinkedIn
   * import sat at a bare "recognizing" for six minutes, indistinguishable from
   * a hang. The stage writes nothing between "recognizing" and the first
   * "parsing …", so this tick is the only thing that can show the difference.
   */
  private async recognize(context: StageRunContext, scratchDir: string): Promise<DataSourceRecognition[]> {
    const entry: DirEntry = {
      filename: path.basename(scratchDir),
      fullPath: scratchDir,
      fsRoot: scratchDir,
    };

    // Locally throttled: the listener already caps writes at one per second,
    // but every un-throttled call still costs a promise and a formatted string
    // per directory entry. Fire-and-forget — recognition must not wait on its
    // own progress line.
    let lastTick = 0;
    const matches = await dataSourcesRecognize(
      undefined,
      entry,
      {},
      {
        descend: true,
        onEntry: (scanned) => {
          const now = Date.now();

          if (now - lastTick < 1_000) {
            return;
          }

          lastTick = now;
          void context
            .progress({ processed: 0, total: null, phase: `recognizing (${scanned} scanned)` })
            .catch(() => undefined);
        },
      },
    );

    return dropGenericWhenSpecialised(matches);
  }

  /** Run one importer, staging everything it emits. */
  private async parseOne(
    context: StageRunContext,
    match: DataSourceRecognition,
    writer: StagedWriter,
    report: (staged: number) => Promise<void>,
  ): Promise<StagedCounts> {
    const name = match.data_source.name;
    const importer = match.data_source.newFileImporter?.();

    if (importer == null) {
      throw new Error(`${name} recognized the tree but has no file importer`);
    }

    // The path that actually matched, not the scratch root: recognition may have
    // found this source several levels down, and running it against the root
    // makes it re-scan the whole tree to find what it already located.
    const matchedPath = match.matchedPath ?? context.scratchDir;
    const entry: DirEntry = {
      filename: path.basename(matchedPath),
      fullPath: matchedPath,
      fsRoot: context.scratchDir,
    };

    // A source's progress is sampled from the writer WHILE it parses, not read
    // off the return value once it finishes. One source can be most of an
    // import -- a Google Voice export is 73,124 files and stages 157k+ records
    // -- and reporting only between sources left `processed` frozen at the
    // previous source's total for the entire hour that one ran, while the rows
    // it was writing climbed by ~590/second. A frozen counter is worse than no
    // counter: it reads as a hung import.
    //
    // The listener already throttles `progress` to one write a second, so
    // sampling on a timer here costs nothing extra and cannot outrun the DB.
    const ticker = setInterval(() => {
      const live = writer.totals;

      void report(live.items + live.entities).catch(() => undefined);
    }, PROGRESS_SAMPLE_MS);

    try {
      await importer.fileImport(undefined, entry, {
        pipeline: writer,
        // Where datasources that materialise bytes (MMS parts in
        // `sms_backup_restore`) are allowed to write them. Left unset they fall
        // back to `os.tmpdir()`, which is exactly the hazard `configuration.ts`
        // and `ImportScratchService` both call out: `/tmp` is tmpfs on a stock
        // appliance, so a large export would consume RAM until the machine died —
        // and nothing sweeps it, because the purge cron owns `uploadsDir` and the
        // scratch service owns `scratchDir`. Pointing it at this run's scratch
        // puts those bytes under the reclaim that already runs when the run ends.
        mediaStoreDir: context.scratchDir,
        // Set only on the surviving `generic` match by `dropGenericWhenSpecialised`
        // — every other match's `excludePaths` is undefined, and every importer
        // but `generic` ignores the field regardless.
        excludePaths: match.excludePaths,
        log: (level, message, meta) => {
          if (level === 'error' || level === 'warn') {
            this.logger.warn(message, { runId: context.runId, dataSource: name, ...meta });
          }
        },
      });

      // The parser is done producing; everything it pushed still has to land.
      await writer.settled();
    } finally {
      clearInterval(ticker);
    }

    this.logger.log('Staged a data source', {
      runId: context.runId,
      dataSource: name,
      ...writer.totals,
    });

    // Returned for main's contract, but the caller deliberately reads
    // `writer.totals` itself AFTER its try/catch instead: a parser that staged
    // 300,000 rows and then hit one unreadable file never reaches this return,
    // and those rows are real. The writer is the honest ledger either way.
    return writer.totals;
  }
}

/**
 * One parser's pass, as a reconciled unit.
 *
 * The two counters that were NOT in any ledger get one here, which is what
 * makes `consumed = produced + dropped` hold for a parse:
 *
 *  - `itemsDeduped` — the album-replicated photo collapsing. Expected, and
 *    counted as `duplicate_in_run`. The `collapsed-distinct-path` subset is
 *    subtracted out because `StagedWriter.recordCollapse` already put those in
 *    the drop ledger under their own slug, and double-counting them would make
 *    the unit fail to reconcile.
 *  - `entitiesGrown` — a repeat sighting of a person or a dish merged into the
 *    row already staged. Also a record consumed that did not become a new row.
 *
 * `consumed` is derived (`produced + dropped`) unless the parser called
 * `pipeline.consumed()` — `counts.recordsRead` is then a MEASURED figure
 * (`consumedOverride`), and the reconciliation check in `stageSummary.ts` can
 * actually fail for that unit instead of holding by construction. A parser
 * that never calls it keeps the derived floor, which can never disagree with
 * itself.
 *
 * `counts.keeps` is deliberately NOT folded in here. A keep is a record a gate
 * would have discarded and the parser rescued — it IS in `produced`, so adding
 * it to `drops` would count one row as both made and lost, and the run UI
 * renders `drops` as the loss report. It rides on `detail.sources[].keeps`
 * instead (ParseStage spreads `writer.totals` there).
 */
function parseUnit(
  dataSource: string,
  where: string,
  counts: StagedCounts,
  error: string | null,
): StageUnitInput {
  const collapsedAmbiguous = counts.drops[COLLAPSED_DISTINCT_PATH] ?? 0;
  const drops: Record<string, number> = { ...counts.drops };

  if (counts.itemsDeduped - collapsedAmbiguous > 0) {
    drops.duplicate_in_run = counts.itemsDeduped - collapsedAmbiguous;
  }

  if (counts.entitiesGrown > 0) {
    drops.entity_merged = counts.entitiesGrown;
  }

  return {
    unit: dataSource,
    produced: counts.items + counts.entities,
    drops,
    // Recorded on the unit and not only in a failure line, because a
    // false-positive recognition is a PATH question — `facebook` matched
    // 0/0/{} inside both an Instagram export and a vCard/calendar export on
    // the QA corpus, and the answer is always "look at what it matched".
    path: where,
    ...(error != null ? { error } : {}),
    ...(counts.recordsRead != null ? { consumedOverride: counts.recordsRead } : {}),
  };
}

/**
 * Keep the catch-all out of what a real parser already claimed — scoped to
 * PATHS, not silenced for the whole run just because a real parser matched
 * somewhere.
 *
 * `generic` returns `confidence: 1` unconditionally without inspecting
 * anything, so it matches every archive — and because this stage runs EVERY
 * recognized source, an unscoped `generic` re-reads everything the specialised
 * parsers had already read. On a real Google Takeout that produced 80,067
 * duplicate staged rows next to 309,689 Google Voice ones, with 67,065
 * filenames overlapping exactly. They push as contentless `ci.content` rows
 * (no text, no url, no file, no event), and since `ci.content` carries no time
 * column they sort ahead of every genuine memory — so the default Memory view
 * became 80k empty stubs, and per-source counts were inflated 17.5%.
 *
 * The FIRST fix here (upstream did this selection in its drop zone,
 * `cands.filter(c => c.dataSource !== 'generic')`) dropped `generic` outright
 * whenever ANY specialised source matched ANYWHERE in the tree — name-only,
 * path-blind. That over-corrected: `facebook.ts` returns `confidence: 0.6` for
 * ANY directory that merely contains a `messages/` entry, no further
 * inspection, and that single weak signal anywhere in a drag-and-drop tree was
 * enough to zero out `generic` for the WHOLE tree — including a loose file
 * dropped somewhere facebook's recognizer never touched, which then silently
 * never imported at all. This function now scopes the exclusion to the paths
 * that actually got claimed instead.
 *
 * A directory-level match is treated as claiming its ENTIRE `matchedPath`
 * subtree, not just the specific files its importer happens to read out of
 * it — the same conservative reading a 0.6 `facebook` guess needs: excluding
 * everything under that directory is what avoids re-staging files it already
 * owns, without this function having to know exactly which files that were.
 * `generic`'s own walker (`datasources/generic.ts`) is what actually prunes
 * those subtrees at fileImport time, via the `excludePaths` this function
 * attaches to the surviving `generic` match — see `ParseStage.parseOne` and
 * `ImportParams.excludePaths`.
 *
 * `generic` stays as the SOLE match when nothing specialised matched at all —
 * that's the bare `.gpx` / loose-PDF drag-and-drop case, and there is nothing
 * to scope around, so it keeps running exactly as before.
 *
 * Path info is required to compute a scoped exclusion; where it is missing —
 * every fixture in `genericExclusion.test.ts` included — there is nothing to
 * decide "covered vs. not" with, so this falls back to the original
 * all-or-nothing drop: the safe default when there is no exclusion mechanism
 * to lean on, matching `isAncestorPath`'s own "unknown means nested" fallback
 * in `registry.ts`.
 */
export function dropGenericWhenSpecialised(matches: DataSourceRecognition[]): DataSourceRecognition[] {
  const specialised = matches.filter((match) => match.data_source.name !== GENERIC_DATA_SOURCE);

  if (specialised.length === 0) {
    // Sole survivor: no specialised claims to scope around.
    return matches;
  }

  const generic = matches.find((match) => match.data_source.name === GENERIC_DATA_SOURCE);

  if (!generic) {
    return specialised;
  }

  const excludePaths: string[] = [];

  for (const match of specialised) {
    if (pathCoveredBy(generic.matchedPath, match.matchedPath)) {
      // This one claim already spans everything `generic` would see — there is
      // nothing left to scope around, so drop it entirely (today's behavior).
      return specialised;
    }

    if (pathStrictlyContains(generic.matchedPath, match.matchedPath)) {
      excludePaths.push(match.matchedPath as string);
    }
  }

  if (excludePaths.length === 0) {
    // No specialised claim sat inside `generic`'s own tree (including every
    // case where path info was simply absent) — there is nothing to scope
    // around, so fall back to dropping `generic` rather than risk it
    // re-reading something a claim we couldn't place actually covers.
    return specialised;
  }

  return [...specialised, { ...generic, excludePaths }];
}

/**
 * Does `specialisedPath` fully cover `genericPath` — i.e. is there nothing
 * left inside `genericPath` that isn't already claimed? True when either path
 * is unknown (nothing to compute an exclusion from — see
 * `dropGenericWhenSpecialised`'s doc comment) or when `specialisedPath` is
 * `genericPath` itself or an ancestor of it.
 */
function pathCoveredBy(genericPath: string | undefined, specialisedPath: string | undefined): boolean {
  if (genericPath == null || specialisedPath == null) {
    return true;
  }

  return isPathWithinOrEqual(specialisedPath, genericPath);
}

/**
 * Is `specialisedPath` a PROPER descendant of `genericPath` — a claim that
 * sits somewhere inside `generic`'s own tree without being all of it? That is
 * exactly the shape `dataSourcesRecognize`'s dedup produces in practice:
 * `generic` collapses to the scratch tree's root, and every specialised match
 * is either that same root (covered, handled above) or found by descending
 * into it.
 */
function pathStrictlyContains(genericPath: string | undefined, specialisedPath: string | undefined): boolean {
  if (genericPath == null || specialisedPath == null || genericPath === specialisedPath) {
    return false;
  }

  return isPathWithinOrEqual(genericPath, specialisedPath);
}

/**
 * The services a run should be labelled with, most rows first.
 *
 * Ordered by row count so the first name is the one the archive is mostly
 * about: a `generic` fallback that matched a stray CSV sorts to the end rather
 * than leading a list that should say "Audible". Ties break on name so a
 * re-parse produces the same order.
 *
 * Sources that produced NOTHING are dropped. A parser recognising a file and
 * then finding no rows in it is not something the run was — and `recognized`
 * in the stage detail still records that it matched, for anyone debugging why
 * a file went nowhere.
 */
export function rankDataSources(perSource: ReadonlyArray<Record<string, unknown>>): string[] {
  return perSource
    .map((entry) => ({
      name: String(entry.dataSource ?? ''),
      rows: Number(entry.items ?? 0) + Number(entry.entities ?? 0),
    }))
    .filter((entry) => entry.name.length > 0 && entry.rows > 0)
    .sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name))
    .map((entry) => entry.name);
}
