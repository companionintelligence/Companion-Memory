import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { embedSkipReason, EmbeddingGenerationService } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { PIPELINE_QUEUES, STAGE_IDS } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';

/**
 * Alias for {@link STAGE_IDS.INDEX_EMBED}, which is now the sole declaration.
 *
 * This used to be a local string literal, landed ahead of the `constants.ts`
 * entry. It survives only as an alias because `__tests__/EmbedStage.spec.ts`
 * imports the name; new code reads `STAGE_IDS.INDEX_EMBED`, and the alias goes
 * away with the change that owns that spec.
 *
 * IDS ARE PERMANENT — the id is the third component of `ci.pipeline_state`'s
 * primary key, so renaming it abandons every ledger row written under the old
 * name.
 */
export const INDEX_EMBED_STAGE_ID = STAGE_IDS.INDEX_EMBED;

/**
 * Dimensionality of `ci_search.embeddings.embedding`, which is `vector(768)`.
 *
 * Hardcoded because it is a SCHEMA fact, not a tunable: pgvector fixes the
 * column width at DDL time, so changing it is a migration, and a migration that
 * changes it MUST change this line in the same commit. That coupling is the
 * point — see {@link embedStageVersion}, which folds this number into the stage
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
 * genuinely dangerous here, and it is worth being explicit about why, because it
 * is the first thing anyone reaches for.
 *
 * `versions.ts` documents the invariant: **versions only ever go UP.** A row is
 * re-selected by `stage_version < $current`, so a version that DECREASES leaves
 * every already-processed row looking stale-forward — its recorded version
 * exceeds the current one, the comparison is false, and the row is never
 * re-selected again, including by the next bump until it climbs past the
 * abandoned high-water mark. A hash is uniformly distributed, so switching
 * models has a ~50 % chance of moving the version DOWN, which would silently
 * pin the entire corpus to the previous model's vectors — the exact bug this
 * derivation exists to fix, reintroduced by the fix.
 *
 * So generations are DECLARED and APPEND-ONLY. Adopting a new model is one line
 * here, and the boot guard below plus {@link embedStageVersion}'s throw make it
 * impossible to run against a model whose generation nobody chose. A hard
 * failure at boot with the exact line to add is a strictly better outcome than
 * an appliance that quietly indexes into a mixed vector space.
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
  /** v1 — the shipped default. `CI_EMBED_MODEL` unset resolves to this. */
  'nomic-embed-text@768': 1,
};

/** The key a `(model, dimension)` pair is declared under. */
function modelKey(model: string, dimension: number): string {
  return `${model}@${dimension}`;
}

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
  const key = modelKey(model, dimension);
  const generation = generations[key];

  if (generation == null) {
    const next = Math.max(0, ...Object.values(generations)) + 1;

    throw new Error(
      `No embedding generation declared for "${key}". Refusing to embed: an undeclared model would have ` +
        `to be given an invented stage version, and a version that lands BELOW an existing one hides ` +
        `every already-embedded row from the staleness sweep forever, leaving the index a silent mix of ` +
        `two models' vectors. Add '${key}': ${next} to EMBED_MODEL_GENERATIONS in ` +
        `domains/pipeline/stages/index/EmbedStage.ts (append only — never reuse or edit an existing ` +
        `generation), and expect the next sweep to re-embed the whole corpus.`,
    );
  }

  return generation;
}

/**
 * Candidate rows for this stage.
 *
 * Note what is ABSENT: there is no `LEFT JOIN ci_search.embeddings e ... WHERE
 * e.entity_id IS NULL`, and no `LEFT JOIN ci_search.index_skips`. Those two
 * anti-joins are how `SearchIndexBackfillService` decides what still needs
 * embedding, and together they are the same one-way ratchet as `width IS NULL`
 * wearing a different hat: the presence of the OUTPUT is the definition of done,
 * so the model that produced it is irrelevant and improving it repairs nothing.
 * `StageRegistry` rejects a predicate that reaches into the ledger for the
 * mirror-image reason.
 *
 * What is left is pure applicability: a content row belonging to a user. Whether
 * it has been embedded, by which model, and what happened if it was not, all
 * live in `ci.pipeline_state`.
 *
 * `user_id IS NOT NULL` is not needed — the sweep binds `s.user_id = $3` — but
 * `ci.content.user_id` is nullable and rows with a NULL owner are unreachable by
 * any user-scoped sweep, which is worth knowing when coverage looks short.
 */
export const INDEX_EMBED_SOURCE: StageSource = {
  schema: 'ci',
  table: 'content',
  idColumn: 'id',
  userColumn: 'user_id',
};

/**
 * The ledger `entity_type` AND the `ci_search.embeddings.entity_type` this stage
 * writes. One constant for both on purpose: they must agree, or coverage would
 * be recorded under a key that does not match the rows the index actually holds.
 */
const ENTITY_TYPE = 'content';

/** The columns the search document is built from. One round trip per slice. */
interface ContentRow {
  id: string;
  type: string | null;
  title: string | null;
  text: string | null;
  url: string | null;
  mimetype: string | null;
}

/**
 * Error text that means "Ollama is not answering", as opposed to "Ollama
 * answered and refused".
 *
 * Matched on the message because the `ollama` client surfaces undici/node
 * connection failures as ordinary `Error`s with these codes embedded, and the
 * distinction is worth keeping: an unreachable host is an appliance-level
 * incident affecting every row, while a model-level rejection is about the
 * request. Both are `failed` — only the recorded reason differs, and the reason
 * is what an operator groups by.
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

function isUnreachable(message: string): boolean {
  return UNREACHABLE_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * Dense-embeds `ci.content` rows into `ci_search.embeddings`.
 *
 * The second conversion, and the one that proves the ledger is worth having:
 * this stage's version is not a hand-chosen integer but a function of the
 * embedding model itself (see {@link embedStageVersion}), so swapping
 * `CI_EMBED_MODEL` re-embeds the corpus with no script, no truncate and no
 * operator remembering to.
 *
 * ── What it replaces, and what it does not ─────────────────────────────────
 *
 * `SearchIndexBackfillService` remains in place; a later phase retires it. The
 * two differ in what "already indexed" means: the backfill asks
 * `ci_search.embeddings` (an embedding exists → done, forever, whatever produced
 * it), this asks `ci.pipeline_state` (this stage, at this version, recorded an
 * outcome). It also does strictly less: the backfill re-emits `ContentCreatedEvent`
 * so the whole `ContentSearchIndexListener` runs, which writes the tsvector as
 * well. This stage writes the DENSE EMBEDDING only — the id says `index.embed`,
 * and the tsvector belongs to a sibling `index.vector` stage rather than being
 * smuggled in here where a version bump could not address it separately.
 *
 * ── Skips are recorded, not silent ─────────────────────────────────────────
 *
 * `embedSkipReason` already knows that empty / too-short / trivial-reaction /
 * bare-URL text is not worth a vector — roughly 13 % of the communication corpus
 * — and the listeners have always honoured it. What they could not do is REMEMBER
 * it: a skipped row simply had no `ci_search.embeddings` entry, which is
 * indistinguishable from a row that failed, or one Ollama never got to. The
 * convergence hack for that is `ci_search.index_skips`, a second table whose
 * only job is to make the anti-join stop re-finding deliberate skips. Here the
 * ledger row IS the skip marker: `skipped: 'too-short'`, one row, countable and
 * greppable, and re-openable by a version bump. This stage therefore does NOT
 * write `ci_search.index_skips` — `SearchIndexBackfillService` still needs that
 * table while it exists, and it is that service's to write.
 *
 * ── A dead Ollama is a rising failure count ────────────────────────────────
 *
 * The single most important operational property. Today an Ollama outage means
 * search-index jobs fail, pg-boss retries them into the archive, and the only
 * visible symptom is that the embedded count stops climbing — indistinguishable
 * from a drain that finished. Here every id in the slice is recorded
 * `failed: ollama_unreachable`, with a retry gate, so the outage reads as a
 * number going UP on `GET /api/pipeline/state` rather than a number that stopped
 * going up.
 */
@Injectable()
export class EmbedStage implements Stage {
  readonly id = STAGE_IDS.INDEX_EMBED;

  /**
   * Resolved ONCE, at construction, not per call.
   *
   * A getter reading `config.embedding.model` on every access would let the
   * version change underneath a slice that is mid-flight: ids claimed at version
   * 1 would be completed at version 2 and never re-embedded by the model that
   * bump was for. Capturing at construction means a model change takes effect on
   * restart — the same lifecycle `EmbeddingGenerationService` already has, since
   * it captures the model into its own field.
   *
   * ── Why this calls the derivation and not `stageVersion(id)` ───────────────
   *
   * Every other stage reads its version out of `STAGE_VERSIONS` via
   * `stageVersion()`, because a hardcoded integer would make bumping the constant
   * a no-op. This one cannot, and the reason is structural rather than a
   * preference: `STAGE_VERSIONS['index.embed']` IS `() => embedStageVersion()`,
   * so `versions.ts` imports this file. Importing it back would close a cycle,
   * which `no-circular` in `.dependency-cruiser.mjs` rejects outright.
   *
   * Nothing is lost, because there is no second number to drift from. The stage
   * and the map call the same function, so agreement is by construction rather
   * than by convention — and `__tests__/stageWiring.spec.ts` asserts
   * `stage.version === stageVersion(stage.id)` for every stage anyway, so this
   * one is held to the identical check as the literal-versioned ones.
   */
  readonly version = embedStageVersion();

  /**
   * `pipeline-embed`: the single host Ollama process is shared with interactive
   * chat, HBPE and the summary sidecar, so a full-corpus re-embed must not be
   * able to take every global worker slot.
   */
  readonly queue = PIPELINE_QUEUES.EMBED;

  readonly entityTypes = [ENTITY_TYPE] as const;

  readonly source = INDEX_EMBED_SOURCE;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(EmbedStage.name);
  }

  /**
   * Embed one slice.
   *
   * Idempotent: the write is a single `ON CONFLICT (entity_type, entity_id) DO
   * UPDATE`, so two workers racing over the same id write the same vector twice
   * and the row is correct either way.
   *
   * Three round trips for a 200-id slice, regardless of its size: one SELECT for
   * the rows, one batched Ollama call for everything worth embedding, one bulk
   * upsert. The batching is not a micro-optimisation — it is the difference
   * between 200 HTTP round trips to a GPU shared with interactive chat and a
   * handful of `CI_EMBED_BATCH_SIZE`-sized ones.
   */
  async run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    const results = new Map<string, StageResult>();

    if (ids.length === 0) {
      return results;
    }

    const rows = await this.loadRows(ctx.userId, ids);
    const byId = new Map(rows.map((row) => [row.id, row]));

    for (const id of ids) {
      if (!byId.has(id)) {
        // Deleted, or re-owned, between the sweep and the slice. A skip, not a
        // failure: there is nothing to retry and nothing was lost.
        results.set(id, { outcome: 'skipped', reason: 'source_row_missing' });
      }
    }

    // Partition before calling Ollama. The low-value rows are decided locally,
    // cost nothing, and — unlike today — leave a record of the decision.
    const embeddable: Array<{ id: string; document: string }> = [];

    for (const row of rows) {
      const document = buildSearchDocument(row);
      const skip = embedSkipReason(document);

      if (skip != null) {
        // `empty` | `too-short` | `trivial` | `url-only`, verbatim, because it
        // is already a stable greppable token and re-spelling it here would
        // make two vocabularies for one decision.
        results.set(row.id, { outcome: 'skipped', reason: skip });

        continue;
      }

      // Non-null by construction: embedSkipReason returned null, which it only
      // does for a non-empty document.
      embeddable.push({ id: row.id, document: document as string });
    }

    if (embeddable.length === 0) {
      return results;
    }

    let vectors: number[][];

    try {
      vectors = await this.embeddingGenerationService.generateEmbeddings(
        embeddable.map((item) => item.document),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const reason = isUnreachable(message) ? 'ollama_unreachable' : 'embed_call_failed';

      // Every id in the batch, not just one: the call is batched, so the failure
      // is genuinely un-attributable to a single row. Each gets its own ledger
      // row with a retry gate, which is what turns an outage into a COUNT that
      // rises rather than a counter that stops.
      for (const item of embeddable) {
        results.set(item.id, { outcome: 'failed', reason, detail: { message } });
      }

      this.logger.error(
        `Embedding call failed for ${embeddable.length} content rows (${reason})`,
        err instanceof Error ? err : new Error(message),
      );

      return results;
    }

    // Vectors are validated BEFORE the write, not during it. A single
    // mis-dimensioned vector would abort the whole bulk upsert — pgvector
    // rejects the cast — so one bad slot would cost every other row in the slice
    // an attempt. Screened out here, it costs only itself.
    const writable: Array<{ id: string; vector: number[] }> = [];

    embeddable.forEach((item, index) => {
      const embedding = vectors[index];

      if (embedding == null || embedding.length === 0) {
        // `generateEmbeddings` already rejects a short response, so reaching
        // here means its "one vector per input, in order" contract broke in a
        // way it did not catch.
        results.set(item.id, { outcome: 'failed', reason: 'empty_embedding_vector' });

        return;
      }

      if (embedding.length !== EMBEDDING_DIMENSION) {
        // The configured model does not produce the width `ci_search.embeddings`
        // was built for. That is a whole-appliance misconfiguration rather than
        // a property of this row, and the operator needs to see it as a distinct
        // reason — not as a generic write failure buried in an error string.
        results.set(item.id, {
          outcome: 'failed',
          reason: 'embedding_dimension_mismatch',
          detail: {
            expected: EMBEDDING_DIMENSION,
            received: embedding.length,
            model: config.embedding.model,
          },
        });

        return;
      }

      writable.push({ id: item.id, vector: embedding });
    });

    if (writable.length === 0) {
      return results;
    }

    try {
      await this.writeEmbeddings(ctx.userId, writable);

      for (const item of writable) {
        results.set(item.id, { outcome: 'done' });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // One statement means one outcome: it committed or it did not, so every
      // row in it shares the verdict. Attributing the failure to one id would be
      // a guess, and a guess is what the reason column exists to replace.
      for (const item of writable) {
        results.set(item.id, { outcome: 'failed', reason: 'embedding_write_failed', detail: { message } });
      }

      this.logger.error(
        `Embedding upsert failed for ${writable.length} content rows`,
        err instanceof Error ? err : new Error(message),
      );
    }

    return results;
  }

  /**
   * The slice's rows, in one statement.
   *
   * Raw SQL rather than `ContentService`, for two reasons: the columns wanted
   * are a strict subset (a `ci.content` row carries a `source_data` jsonb blob
   * that is dead weight at 200 rows a slice), and going through the memory
   * domain's barrel from inside `domains/pipeline` would couple the pipeline's
   * module graph to it for a projection.
   *
   * User-scoped even though the sweep already was: a slice can arrive from a
   * dead letter replayed weeks later, and re-scoping is the difference between
   * "not yours" and embedding someone else's content under this user's id.
   */
  private loadRows(userId: string, ids: string[]): Promise<ContentRow[]> {
    return this.dataSource.query<ContentRow[]>(
      `SELECT c.id, c.type, c.title, c.text, c.url, c.mimetype
         FROM ci.content c
        WHERE c.id = ANY($1::uuid[])
          AND c.user_id = $2::uuid`,
      [ids, userId],
    );
  }

  /**
   * Persist the slice's vectors in ONE upsert.
   *
   * The statement is deliberately identical in meaning to
   * `SearchIngress.EmbeddingService.upsert` — same table, same conflict target,
   * same `updated_at = now()` — but set-based rather than per row, because a
   * per-row upsert over a slice is 200 round trips and the per-row version of
   * this pattern is precisely why the search-index queue sat >95 % undrained.
   *
   * Written here rather than by injecting that service because `SearchIngressModule`
   * does not export it, and reaching into another domain's internals is a
   * dependency-cruiser error (`no-cross-domain-internals`). Exporting it and
   * injecting it would be the better long-term shape, and belongs with the
   * change that retires `SearchIndexBackfillService`; until then this comment is
   * the link between the two copies.
   *
   * Ids are v7 so rows sort by insertion time, matching every other insert into
   * this table. They are only used for brand-new rows: on conflict the existing
   * id is kept.
   */
  private async writeEmbeddings(
    userId: string,
    items: Array<{ id: string; vector: number[] }>,
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO ci_search.embeddings AS e (id, entity_type, entity_id, embedding, user_id)
       SELECT t.id, $1, t.entity_id, t.embedding::vector, $2::uuid
         FROM unnest($3::uuid[], $4::uuid[], $5::text[]) AS t(id, entity_id, embedding)
       ON CONFLICT (entity_type, entity_id) DO UPDATE
          SET embedding = EXCLUDED.embedding, updated_at = now()`,
      [
        ENTITY_TYPE,
        userId,
        items.map(() => uuidv7()),
        items.map((item) => item.id),
        // The pgvector text literal `[a,b,c]`, mirroring the entity's column
        // transformer and `EmbeddingService.upsert`.
        items.map((item) => `[${item.vector.join(',')}]`),
      ],
    );
  }
}

/**
 * The text that gets embedded.
 *
 * DELIBERATELY IDENTICAL to `ContentSearchIndexListener.getSearchDocument` —
 * same fields, same order, same de-duplication, same "join with a space". The
 * two paths must produce byte-identical documents or the same row embeds to two
 * different vectors depending on which one reached it, and every distance
 * against it becomes a coin flip.
 *
 * That duplication is a real risk and it is here on purpose rather than being
 * papered over: the listener is not this change's to touch. Collapsing the two
 * onto one exported document builder is the correct follow-up, and belongs with
 * the change that retires `SearchIndexBackfillService`.
 *
 * Returns `null` when nothing usable is present, which `embedSkipReason` then
 * reports as `empty`.
 */
export function buildSearchDocument(row: ContentRow): string | null {
  const parts = new Set<string>();

  const push = (value: unknown) => {
    if (typeof value !== 'string') {
      return;
    }

    const normalized = value.trim();

    if (normalized.length === 0) {
      return;
    }

    parts.add(normalized);
  };

  push(row.text);
  push(row.type);
  push(row.mimetype);
  push(row.title);
  push(row.url);

  const result = Array.from(parts).join(' ');

  return result.length > 0 ? result : null;
}
