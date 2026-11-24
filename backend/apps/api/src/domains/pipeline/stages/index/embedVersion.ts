import {
  EMBEDDING_DIMENSION,
  EMBED_MODEL_GENERATIONS,
  canonicalEmbedModel,
  modelKey,
} from '@ci/common/embeddings/embedModelIdentity';
import config from '@ci/configuration';

export {
  EMBEDDING_DIMENSION,
  EMBED_MODEL_GENERATIONS,
  isDeclaredEmbedModel,
} from '@ci/common/embeddings/embedModelIdentity';

/**
 * The dense-embedding version machinery, shared by every `index.embed*` stage.
 *
 * Moved out of `EmbedStage.ts` when the per-entity-type embed stages joined it
 * (they all embed with the same model into the same `vector(768)` column, so
 * they all carry the same derived version). `EmbedStage.ts` re-exports
 * everything here, so existing importers — `versions.ts`, the specs — keep
 * their path.
 */

/**
 * Boot-time guard on {@link EMBED_MODEL_GENERATIONS}.
 *
 * Two mistakes, both invisible until a sweep silently returns the wrong set:
 *
 *  - **a non-integer or non-positive generation** — `stage_version` is `INTEGER`
 *    in Postgres, so `1.5` truncates to 1 and the "bump" is a no-op; and
 *    `versions.ts` rejects 0 because a stage at version 0 makes rows stranded in
 *    `status='running'` unreclaimable by the staleness sweep.
 *  - **two models sharing a generation** — the whole mechanism is "a different
 *    model means a different version". Two models at the same number means
 *    switching between them re-embeds nothing, which is the original bug.
 *
 * Runs at module load: an incomplete declaration is a programming error, and the
 * earliest failure is the cheapest one.
 */
export function assertEmbedModelGenerations(
  generations: Record<string, number> = EMBED_MODEL_GENERATIONS,
): void {
  const seen = new Map<number, string>();

  for (const [key, generation] of Object.entries(generations)) {
    if (!Number.isInteger(generation) || generation < 1) {
      throw new Error(
        `EMBED_MODEL_GENERATIONS["${key}"] must be an integer >= 1, got ${String(generation)}. ` +
          `A fractional generation truncates to an integer in Postgres so the bump would be a no-op, and ` +
          `generation 0 makes rows stranded in status='running' unreclaimable by the staleness sweep.`,
      );
    }

    const clash = seen.get(generation);

    if (clash != null) {
      throw new Error(
        `EMBED_MODEL_GENERATIONS declares generation ${generation} for both "${clash}" and "${key}". ` +
          `Two models sharing a generation means switching between them re-embeds nothing — the exact ` +
          `defect deriving the version from the model exists to fix. Generations are append-only and unique.`,
      );
    }

    seen.set(generation, key);
  }
}

assertEmbedModelGenerations();

/**
 * The stage version for a `(model, dimension)` pair.
 *
 * Defaults to the live configuration, so in production this is literally "the
 * version of the model this appliance is embedding with". Both arguments are
 * overridable so a test can prove the property that matters — that changing the
 * model changes the version, and therefore re-selects every row — without
 * mutating global config.
 *
 * Throws for an undeclared pair rather than inventing a number. See
 * {@link EMBED_MODEL_GENERATIONS} for why: an invented version can go DOWN, and
 * a version that goes down permanently hides the corpus from every future sweep.
 */
export function embedStageVersion(
  model: string = config.embedding.model,
  dimension: number = EMBEDDING_DIMENSION,
  generations: Record<string, number> = EMBED_MODEL_GENERATIONS,
): number {
  const key = modelKey(canonicalEmbedModel(model), dimension);
  const generation = generations[key];

  if (generation == null) {
    const next = Math.max(0, ...Object.values(generations)) + 1;

    throw new Error(
      `No embedding generation declared for "${key}". Refusing to embed: an undeclared model would have ` +
        `to be given an invented stage version, and a version that lands BELOW an existing one hides ` +
        `every already-embedded row from the staleness sweep forever, leaving the index a silent mix of ` +
        `two models' vectors. Add '${key}': ${next} to EMBED_MODEL_GENERATIONS in ` +
        `domains/pipeline/stages/index/embedVersion.ts (append only — never reuse or edit an existing ` +
        `generation), and expect the next sweep to re-embed the whole corpus.`,
    );
  }

  return generation;
}

/**
 * Error text that means "Ollama is not answering", as opposed to "Ollama
 * answered and refused".
 *
 * Matched on the message because the `ollama` client surfaces undici/node
 * connection failures as ordinary `Error`s with these codes embedded, and the
 * distinction is worth keeping: an unreachable host is an appliance-level
 * incident affecting every row, while a model-level rejection is about the
 * request. Both are `failed`, and the recorded reason is what an operator groups
 * by AND what the ledger classifies on: `ollama_unreachable` is declared in
 * `TRANSIENT_FAILURE_REASONS`, so an Ollama restart refunds the attempt and
 * backs off on the long schedule, while `embed_call_failed` spends the
 * quarantine budget exactly as before.
 */
const UNREACHABLE_PATTERNS = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'fetch failed',
  'Failed to fetch',
];

export function isUnreachable(message: string): boolean {
  return UNREACHABLE_PATTERNS.some((pattern) => message.includes(pattern));
}
