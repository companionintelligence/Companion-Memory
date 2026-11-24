/**
 * Which embedding-model NAMES are the same model.
 *
 * The name an engine serves an embedder under is the engine's, not the model's. Ollama calls
 * nomic-embed-text v1.5 `nomic-embed-text` (also `:latest`, `:v1.5`); CI-Hub installs the same F16
 * weights into Lemonade, which lists them as `nomic-embed-text-v1.5-GGUF` (registered as
 * `user.nomic-embed-text-v1.5-GGUF`). The index cares about the vectors, not the name: measured
 * 2026-09-29, the two engines' vectors for the same text agree at cosine 0.99996–0.99998. Keying the
 * embed stage version on the raw name would re-embed a whole corpus for moving between engines,
 * and refuse to boot on the second name.
 *
 * Deliberately NOT an alias: Lemonade's built-in `nomic-embed-text-v1-GGUF`. That is nomic v1, and
 * its vectors agree with v1.5's at only 0.69–0.73 — a different vector space that would silently
 * scramble an index built with v1.5.
 *
 * Pure (no configuration import), so `configuration.ts` can use it while resolving the model. The
 * generation table lives here for the same reason; `embedVersion.ts` re-exports it.
 */
const EMBED_MODEL_ALIASES: Readonly<Record<string, string>> = {
  'nomic-embed-text:latest': 'nomic-embed-text',
  'nomic-embed-text:v1.5': 'nomic-embed-text',
  'nomic-embed-text-v1.5-GGUF': 'nomic-embed-text',
  'user.nomic-embed-text-v1.5-GGUF': 'nomic-embed-text',
};

/** The name a model's embed generation is declared under: the alias's target, or the name itself. */
export function canonicalEmbedModel(model: string): string {
  const trimmed = model.trim();

  return EMBED_MODEL_ALIASES[trimmed] ?? trimmed;
}

/**
 * Dimensionality of `ci_search.embeddings.embedding`, which is `vector(768)`.
 *
 * Hardcoded because it is a SCHEMA fact, not a tunable: pgvector fixes the
 * column width at DDL time, so changing it is a migration, and a migration that
 * changes it MUST change this line in the same commit. That coupling is the
 * point — see `embedStageVersion` (embedVersion.ts), which folds this number into the stage
 * version, so a re-dimension automatically re-embeds the corpus that no longer
 * fits.
 */
export const EMBEDDING_DIMENSION = 768;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HEADLINE CAPABILITY: CHANGING THE EMBEDDING MODEL RE-EMBEDS EVERYTHING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `(model, dimension)` → the stage version rows embedded by that model carry.
 *
 * ── The defect this deletes ────────────────────────────────────────────────
 *
 * `SearchIndexBackfillService.missingIds` selects work with
 * `LEFT JOIN ci_search.embeddings e ... WHERE e.entity_id IS NULL`. A row that
 * HAS an embedding is, by that predicate, permanently finished — regardless of
 * which model produced the vector. So switching `CI_EMBED_MODEL` today produces
 * an index in which old rows hold `nomic-embed-text` vectors and new rows hold
 * the new model's, in the same 768-dimensional column, silently, forever.
 * Cosine distance between two different models' vectors is meaningless, so
 * search quality degrades in a way that shows up as "results feel worse" and
 * cannot be traced back to the switch. Repairing it requires
 * `TRUNCATE ci_search.embeddings` and a full re-index, which is exactly the
 * "delete everything and start over" migration the ledger exists to remove.
 *
 * With the version derived from the model, the switch IS the re-embed: every
 * row recorded at the old model's generation fails `stage_version < $current`
 * on the very next sweep and comes back. No backfill script, no truncate.
 *
 * ── Why a declared map and not a hash ──────────────────────────────────────
 *
 * The obvious implementation — `version = hash(model + dimension)` — is
 * genuinely dangerous here. `versions.ts` documents the invariant: **versions
 * only ever go UP.** A row is re-selected by `stage_version < $current`, so a
 * version that DECREASES leaves every already-processed row looking
 * stale-forward — its recorded version exceeds the current one, the comparison
 * is false, and the row is never re-selected again, including by the next bump
 * until it climbs past the abandoned high-water mark. A hash is uniformly
 * distributed, so switching models has a ~50 % chance of moving the version
 * DOWN, which would silently pin the entire corpus to the previous model's
 * vectors — the exact bug this derivation exists to fix, reintroduced by the
 * fix.
 *
 * So generations are DECLARED and APPEND-ONLY. Adopting a new model is one line
 * here, and the boot guard plus `embedStageVersion`'s throw (both in embedVersion.ts) make it
 * impossible to run against a model whose generation nobody chose.
 *
 * ── Adding a model ─────────────────────────────────────────────────────────
 *
 * Append `'<model>@<dimension>': <max generation + 1>`. Never edit or reuse an
 * existing entry: the generation is what already-written ledger rows are
 * compared against, and reusing a number tells the sweep that rows embedded by a
 * DIFFERENT model are current.
 *
 * Dry-run before you deploy it. On a single appliance sharing one Ollama host
 * process with interactive chat, HBPE and the summary sidecar, re-embedding the
 * full corpus is hours of contended GPU time. Get the candidate count before you
 * get the bill.
 */
export const EMBED_MODEL_GENERATIONS: Readonly<Record<string, number>> = {
  /**
   * v1 — the shipped default. `CI_EMBED_MODEL` unset resolves to this. Declared under the canonical
   * name (`canonicalEmbedModel`): Lemonade's `nomic-embed-text-v1.5-GGUF` is the same weights and the
   * same generation, so moving between engines re-embeds nothing.
   */
  'nomic-embed-text@768': 1,
};

/** Whether `model` (any engine's name for it) has a declared generation at `dimension`. */
export function isDeclaredEmbedModel(
  model: string,
  dimension: number = EMBEDDING_DIMENSION,
  generations: Record<string, number> = EMBED_MODEL_GENERATIONS,
): boolean {
  return generations[modelKey(canonicalEmbedModel(model), dimension)] != null;
}

/** The key a `(model, dimension)` pair is declared under. */
export function modelKey(model: string, dimension: number): string {
  return `${model}@${dimension}`;
}
