import { STAGE_IDS, type StageId } from './constants';
// The derivation, imported rather than re-implemented. This is the ONLY edge
// from `versions.ts` into `stages/`, and it is deliberately one-way: `EmbedStage`
// must not import this file back, or `no-circular` in `.dependency-cruiser.mjs`
// fails the build. See {@link STAGE_VERSIONS}' entry for `index.embed`.
import { embedStageVersion } from './stages/index/EmbedStage';

/**
 * A declared stage version: a literal integer, or a zero-arg thunk returning one.
 *
 * MOST stages have a version a human bumps by hand, and for those the literal is
 * strictly better — it is one integer in one diff, and reviewing the bump means
 * reading the same line the enricher's change touched.
 *
 * Some stages do not, and `index.embed` is the reason this union exists. Its
 * version is a function of `(config.embedding.model, pgvector width)`, because
 * changing the embedding model MUST make every existing row stale — cosine
 * distance between two models' vectors is meaningless, so a mixed index is
 * silently wrong. No human-maintained integer expresses that: it works only if
 * whoever changes `CI_EMBED_MODEL` also remembers to bump a number in this file,
 * and the whole subsystem exists because "someone will remember" is not a
 * mechanism.
 *
 * A thunk keeps the derivation next to the thing it derives from — in
 * `EmbedStage.ts`, beside the model-generation table it reads — while leaving
 * this map COMPLETE and diff-reviewable. That completeness is not cosmetic:
 * `StageRegistry`'s boot guard compares this map's keys against
 * `STAGE_REGISTRY`'s, so a stage whose version lived only in its own file would
 * have to be omitted here, and the guard would then have to be weakened for
 * every stage.
 *
 * The thunk is resolved — never trusted — by {@link stageVersion}, which applies
 * the same integer >= 1 check a literal gets. A derivation that returns 0 or a
 * fraction is exactly the latent bug the guard below already documents; being
 * computed rather than typed makes it more likely, not less.
 */
export type StageVersion = number | (() => number);

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
 * Four lines in four files: the id in `constants.ts`, the version here, the
 * token in `STAGE_REGISTRY`, and the provider binding in `stageProviders`
 * (`index.ts`). The boot guard names the first three; it structurally cannot see
 * the fourth, because it compares two maps and a stage missing from both looks
 * consistent — so `__tests__/stageWiring.spec.ts` finds stage classes on disk
 * and fails on any that is not wired all the way through.
 */
export const STAGE_VERSIONS: Record<StageId, StageVersion> = {
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

  /**
   * DERIVED, not chosen — the one entry in this map nobody bumps by hand.
   *
   * `embedStageVersion()` reads `config.embedding.model` and the pgvector column
   * width and looks the pair up in `EMBED_MODEL_GENERATIONS`, so switching
   * `CI_EMBED_MODEL` to a declared model IS the re-embed: every row recorded at
   * the old model's generation fails `stage_version < $current` on the next
   * sweep. Nothing here to bump; the line to add lives beside the derivation, and
   * `embedStageVersion()` throws at boot naming it if the configured model has no
   * generation.
   *
   * A thunk rather than `embedStageVersion()` evaluated here, for one reason
   * that matters and one that does not:
   *
   *  - **Load order.** A call at this line would run while the module graph is
   *    still being built. It happens to be safe today (the import is one-way), but
   *    it makes an ordinary-looking import edge load-bearing, and the failure if
   *    it ever stops being safe is a `ReferenceError` in a constants file at boot.
   *  - It also lets a test resolve the map without a live embedding config —
   *    convenient, not the point.
   */
  [STAGE_IDS.INDEX_EMBED]: () => embedStageVersion(),

  /**
   * v1 — initial writer for `ci.position`'s seven address columns.
   *
   * A LITERAL that mirrors a derivation, which is the third shape and needs its
   * own note. `PositionReverseStage` computes `POSITION_REVERSE_VERSION` from two
   * generations (the reverse-geocode provider, and this stage's
   * component-to-column rule) and cross-checks it against the number here,
   * throwing if they disagree. So the derivation is the authority and this entry
   * is its reviewable mirror — bump a generation there and this line in the same
   * commit.
   *
   * Not a thunk, deliberately: the derivation lives in a file that imports
   * `@ci/domains/geocode`, and a thunk would make every importer of this
   * constants module pull the geocode domain's graph in behind it. The literal
   * costs one line of duplication, guarded by a throw.
   */
  [STAGE_IDS.ENRICH_POSITION_REVERSE]: 1,

  /**
   * v1 — initial conversion of `GeocodeBatchListener`'s forward sweep.
   *
   * A LITERAL mirroring a derivation, the same shape as
   * `enrich.position_reverse`: `GeocodeStage` computes its version from the
   * forward-provider generation plus its own result-rule generation, and throws
   * at module load if this line disagrees. Not a thunk, for the reason given
   * above — that derivation lives in a file importing `@ci/domains/geocode`, and
   * a thunk would drag that whole graph behind every importer of this module.
   */
  [STAGE_IDS.ENRICH_GEOCODE]: 1,

  /**
   * v1 — initial conversion of `LocationEstimateService.estimateBatch`.
   *
   * Also a literal mirroring a derivation, and the derivation's second term is
   * the forward-geocode provider generation: an estimate is a COPY of a donor's
   * coordinate, so improving the geocoder makes every estimate stale. Bumping
   * the provider generation therefore bumps BOTH stages — which is the point,
   * and means this line moves whenever `enrich.geocode`'s does.
   */
  [STAGE_IDS.ENRICH_ESTIMATE_LOCATION]: 1,

  /**
   * v1 — initial conversion of the three participant backfills.
   *
   * Two literals mirroring ONE derivation, which is why they must move
   * together: `PersonLinkStage` computes `PERSON_LINK_VERSION` from three
   * generations (the identifier rule, the match rule, the projection rule) and
   * throws at module load if EITHER of these lines disagrees. So the derivation
   * is the authority and these entries are its reviewable mirror — bump a
   * generation there and both of these lines in the same commit.
   *
   * Not thunks, for the reason `enrich.position_reverse` gives: that file
   * imports `@ci/domains/graph` for the shared normalisation rule, and a thunk
   * would drag the graph domain's whole module graph behind every importer of
   * this constants module.
   *
   * A bump here is the fix for the fill-only-NULL guard all three services
   * shared: it re-opens every row, INCLUDING the ones already carrying a
   * partial link, so a message whose other four recipients finally have
   * contacts gets them.
   */
  [STAGE_IDS.ENRICH_PERSON_LINK]: 1,
  [STAGE_IDS.ENRICH_EVENT_PERSON_LINK]: 1,

  /** v1 — initial temporal repair. Bump when SOURCE_TIME_SPECS gains a source; only a bump re-opens a skip. */
  [STAGE_IDS.CLEAN_TEMPORAL_REPAIR]: 1,

  /** v1 — initial duplicate proposer. A bump rescores pending candidates; it never resurrects a rejected pair. */
  [STAGE_IDS.CLEAN_DUPLICATE_DETECT]: 1,

  /** v1 — initial identifier canonicaliser. Deliberately NOT tied to IDENTITY_SPEC_VERSION, which versions the object identity ladder. */
  [STAGE_IDS.CLEAN_IDENTIFIER_NORMALIZE]: 1,

  /** v1 — place promotion. Derives from the forward-geocode generation: a better provider makes every hierarchy provisional. Cheap to bump — no provider call. */
  [STAGE_IDS.PROMOTE_PLACE]: 1,

  /** v1 — object promotion. A literal: this stage reads nothing another stage produces. Bump when extractPurchase changes. */
  [STAGE_IDS.PROMOTE_OBJECT]: 1,

  /**
   * v3 — deterministic edge projection, all legs. Literals mirroring
   * derivations in `EdgePromoteStage.ts`, which throw at module load if any
   * line disagrees. The communication leg derives from the edge-matrix
   * generation + PERSON_LINK_VERSION (its edges are a COPY of the linker's
   * columns, so a linker bump re-projects); the event leg additionally tracks
   * PROMOTE_PLACE_VERSION (`location_entity_id` is that stage's output); the
   * inventory and observation legs track PROMOTE_OBJECT_VERSION; the content,
   * receipt, position and device legs have no versioned producer (importers,
   * extraction, capture-time snapping and device registration fill their
   * columns), so they are the matrix generation alone. v3 = matrix generation
   * 3: the matrix now covers every entity-linkage pair in the schema —
   * receipts, object observations, positions and devices gained rules. Bump a
   * producer's generation and the matching line here in the same commit.
   *
   * v4 = matrix generation 4: LOCATED_AT/DOCUMENTS canonical storage, Place and
   * File hierarchy legs.
   */
  [STAGE_IDS.PROMOTE_EDGE_COMMUNICATION]: 4,
  [STAGE_IDS.PROMOTE_EDGE_EVENT]: 4,
  [STAGE_IDS.PROMOTE_EDGE_CONTENT]: 4,
  [STAGE_IDS.PROMOTE_EDGE_INVENTORY]: 4,
  [STAGE_IDS.PROMOTE_EDGE_RECEIPT]: 4,
  [STAGE_IDS.PROMOTE_EDGE_OBSERVATION]: 4,
  [STAGE_IDS.PROMOTE_EDGE_POSITION]: 4,
  [STAGE_IDS.PROMOTE_EDGE_DEVICE]: 4,
  [STAGE_IDS.PROMOTE_EDGE_FILE]: 4,
  [STAGE_IDS.PROMOTE_EDGE_PLACE]: 4,
};

/**
 * Collapse a declared version — literal or thunk — to the integer the ledger
 * stores, and refuse anything that is not one.
 *
 * The check catches the two mistakes that are invisible until a sweep silently
 * returns nothing: a version of 0 (which makes crash-stranded `running` rows
 * unreclaimable, see above) and a non-integer (`stage_version` is `INTEGER` in
 * Postgres, so `1.5` would silently truncate to 1 and a "bump" would be a
 * no-op).
 *
 * It applies to a THUNK'S RESULT exactly as it applies to a literal, which is
 * the whole reason resolution lives in one function. A literal is wrong only if
 * someone typed it wrong, and a reviewer sees the digit; a derived version is
 * wrong whenever the arithmetic behind it is, and nobody sees anything. Trusting
 * the computed one and checking the typed one would have it backwards.
 */
function resolveDeclaredVersion(stageId: string, declared: StageVersion): number {
  const version = typeof declared === 'function' ? declared() : declared;

  if (!Number.isInteger(version) || version < 1) {
    throw new Error(
      `STAGE_VERSIONS["${stageId}"] must ${typeof declared === 'function' ? 'derive' : 'be'} an ` +
        `integer >= 1, got ${String(version)}. Version 0 makes rows stranded in status='running' ` +
        `unreclaimable by the staleness sweep, and a fractional version truncates to an integer in ` +
        `Postgres so the bump would be a no-op.`,
    );
  }

  return version;
}

/**
 * Boot-time guard: every declared version resolves to a positive integer.
 *
 * Throwing at module load fails the boot loudly rather than degrading the ledger
 * quietly. Thunks are INVOKED here rather than left for the first sweep: a
 * derivation that cannot produce a version is a stage that cannot run, and the
 * appliance should say so at startup — on the operator's terminal — instead of
 * inside a worker on whichever machine reaches that stage first.
 *
 * That does mean an undeclared `CI_EMBED_MODEL` fails the whole boot, not just
 * `index.embed`. Deliberate: `EmbedStage` would have thrown from its constructor
 * during module construction anyway, and a mis-set embedding model is not a
 * condition to run an appliance in.
 */
for (const [stageId, declared] of Object.entries(STAGE_VERSIONS)) {
  resolveDeclaredVersion(stageId, declared);
}

/**
 * The current version of a stage.
 *
 * Throws rather than defaulting, because a missing version is not a version of
 * 0 — it is a stage nothing can ever mark stale, and defaulting would bury that
 * as normal operation.
 *
 * Resolved on every call, not memoised. A thunk is cheap (a map lookup), and
 * caching would quietly re-introduce the drift the union exists to remove: a
 * stage whose derivation changed mid-process would keep reporting the version it
 * happened to be asked for first. Callers that must not see a version move
 * mid-flight — every `Stage` implementation — capture it once at construction,
 * which is a decision about that stage's lifecycle rather than about this map.
 */
export function stageVersion(stageId: string): number {
  const declared = STAGE_VERSIONS[stageId as StageId];

  if (declared == null) {
    throw new Error(
      `No STAGE_VERSIONS entry for stage "${stageId}". Every stage must declare a version; ` +
        `see domains/pipeline/versions.ts.`,
    );
  }

  return resolveDeclaredVersion(stageId, declared);
}
