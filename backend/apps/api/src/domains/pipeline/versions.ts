import { STAGE_IDS, type StageId } from './constants';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RE-RUN WATERMARK. THIS FILE IS THE POINT OF THE WHOLE REBUILD.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **Incrementing an integer in this map re-processes every existing row for
 * that stage.** There is no backfill script, no `DELETE FROM`, no truncate, no
 * `retryNull` flag, no `forced` boolean. One integer, one commit.
 *
 * Why the rebuild exists: before the ledger, every stage encoded "has this
 * run?" as a nullability predicate on the column it writes —
 * `location_coordinates IS NULL`, `width IS NULL`, `LEFT JOIN
 * ci_search.embeddings ... WHERE e.entity_id IS NULL`,
 * `cardinality(to_entity_ids) = 0`. The predicate that FINDS work is the
 * predicate that DECLARES it done, so the first answer an enricher ever
 * produced was permanent and improving the enricher could not repair history. A
 * better geocoder, a better embedding model, a fixed participant matcher: all
 * of them applied only to rows that happened to arrive afterwards.
 *
 * `ci.pipeline_state.stage_version` breaks that. Candidate selection asks the
 * LEDGER (`stage_version < $current`) instead of asking the output column, so
 * the answer already written is irrelevant to whether the row is eligible.
 *
 * ── How to bump ────────────────────────────────────────────────────────────
 *
 * 1. Change the enricher.
 * 2. Increment its integer here, in the same commit. The version and the code
 *    that justifies it must be reviewable together, or nobody can tell which
 *    version produced which answer.
 * 3. Dry-run first. On a single appliance sharing one Ollama host process with
 *    interactive chat, HBPE and the summary sidecar, a careless bump on an
 *    embedding stage is hours of contended GPU time. Get the candidate count
 *    before you get the bill.
 *
 * ── Rules ──────────────────────────────────────────────────────────────────
 *
 * **Versions only ever go UP.** Rolling one back leaves already-processed rows
 * looking stale-forward — their `stage_version` exceeds the current one, so
 * `stage_version < $current` is false and they are never re-selected again,
 * including by the *next* bump until it passes the abandoned high-water mark. A
 * bad version is superseded by v+1; it is never reverted.
 *
 * **Versions start at 1, never 0.** `claim()` deliberately does not stamp
 * `stage_version`, so a row claimed by a worker that then died keeps the
 * INSERT default of 0. With a minimum live version of 1, `stage_version < 1`
 * re-selects that stranded row on the next sweep. A stage at version 0 would
 * make crashed-mid-slice entities permanently invisible — the exact failure
 * mode the ledger exists to eliminate. Enforced at module load below.
 *
 * **Every id here must be in the registry, and vice versa.** Enforced at boot
 * by `StageRegistry` (see `services/StageRegistry.ts`).
 *
 * ── Adding a stage ─────────────────────────────────────────────────────────
 *
 * Two lines: an id + version here, and an id + provider token in
 * `STAGE_REGISTRY`. The boot guard names anything you miss.
 */
export const STAGE_VERSIONS: Record<StageId, number> = {
  /**
   * v1 — initial conversion of `MediaDimensionsBackfillListener` onto the
   * ledger. Probes `ci.files` originals via sharp (images) / ffprobe (video).
   *
   * Bump when the probe can read something it previously could not — HEIC
   * support, a new container, a fixed rotation/EXIF orientation reading. Rows
   * recorded `skipped: probe_failed` under the old version are re-probed, which
   * is precisely what today's `width IS NULL` predicate can never express: it
   * cannot distinguish "not probed yet" from "probed and unreadable".
   */
  [STAGE_IDS.ENRICH_MEDIA_DIMENSIONS]: 1,
};

/**
 * Boot-time guard: every declared version is a positive integer.
 *
 * Catches the two mistakes that are invisible until a sweep silently returns
 * nothing: a version of 0 (which makes crash-stranded `running` rows
 * unreclaimable, see above) and a non-integer (`stage_version` is `INTEGER` in
 * Postgres, so `1.5` would silently truncate to 1 and a "bump" would be a
 * no-op). Throwing at module load fails the boot loudly rather than degrading
 * the ledger quietly.
 */
for (const [stageId, version] of Object.entries(STAGE_VERSIONS)) {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(
      `STAGE_VERSIONS["${stageId}"] must be an integer >= 1, got ${String(version)}. ` +
        `Version 0 makes rows stranded in status='running' unreclaimable by the staleness sweep, ` +
        `and a fractional version truncates to an integer in Postgres so the bump would be a no-op.`,
    );
  }
}

/**
 * The current version of a stage.
 *
 * Throws rather than defaulting, because a missing version is not a version of
 * 0 — it is a stage nothing can ever mark stale, and defaulting would bury that
 * as normal operation.
 */
export function stageVersion(stageId: string): number {
  const version = STAGE_VERSIONS[stageId as StageId];

  if (version == null) {
    throw new Error(
      `No STAGE_VERSIONS entry for stage "${stageId}". Every stage must declare a version; ` +
        `see domains/pipeline/versions.ts.`,
    );
  }

  return version;
}
