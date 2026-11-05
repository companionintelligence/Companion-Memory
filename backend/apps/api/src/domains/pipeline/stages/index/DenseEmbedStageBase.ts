import type { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import type { EmbeddingGenerationService } from '@ci/common/embeddings';
import { embedSkipReason, searchDocumentHash, shouldEmbedType } from '@ci/common/embeddings';
import type { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { PIPELINE_QUEUES } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';

import { EMBEDDING_DIMENSION, embedStageVersion, isUnreachable } from './embedVersion';

/** One candidate row, reduced to its identity and the text worth embedding. */
export interface EmbedDocumentRow {
  id: string;
  /** `null` when the source row has nothing usable — recorded as `skipped: empty`. */
  document: string | null;
}

/**
 * The dense-embed slice worker, shared by every `index.embed*` stage.
 *
 * One entity type per subclass (a `Stage` declares exactly one `source`); what
 * varies is only WHERE the rows live and WHAT text represents one — the
 * abstract `loadDocuments`, which subclasses implement as one SQL projection
 * handed to the type's shared `searchTexts` builder. Everything else — the
 * batched Ollama call, the dimension screen, the single bulk upsert, the
 * per-row ledger outcomes — is identical by construction, which is the point:
 * a failure mode fixed here is fixed for every type at once.
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
export abstract class DenseEmbedStageBase implements Stage {
  abstract readonly id: string;

  abstract readonly entityTypes: readonly string[];

  abstract readonly source: StageSource;

  /**
   * Apply the message-tuned low-value heuristics (`too-short` / `trivial` /
   * `url-only`) before embedding, mirroring which listeners honour
   * `embedSkipReason`. False for the types whose legitimate documents look like
   * exactly what the heuristics reject — a person IS a bare short name — where
   * only a truly empty document (`null`) skips.
   */
  protected abstract readonly skipHeuristics: boolean;

  /**
   * Mirror of the listener-side `shouldEmbedType` gate (`CI_EMBED_TYPES`).
   * When the type is gated off, the slice records `skipped:
   * embed_type_disabled` — countable, and re-openable by a version bump after
   * the operator turns the type back on.
   */
  protected abstract readonly honorsEmbedAllowlist: boolean;

  /**
   * Resolved ONCE, at construction, not per call — a getter reading
   * `config.embedding.model` on every access would let the version change
   * underneath a slice that is mid-flight. A model change takes effect on
   * restart, the same lifecycle `EmbeddingGenerationService` already has.
   *
   * Every embed stage carries the SAME derived version: they all embed with the
   * same model into the same `vector(768)` column, so one model switch
   * re-embeds every type's corpus. See `embedVersion.ts`.
   */
  readonly version = embedStageVersion();

  /**
   * `pipeline-embed`: the single host Ollama process is shared with interactive
   * chat, HBPE and the summary sidecar, so a full-corpus re-embed must not be
   * able to take every global worker slot.
   */
  readonly queue = PIPELINE_QUEUES.EMBED;

  constructor(
    protected readonly dataSource: DataSource,
    protected readonly embeddingGenerationService: EmbeddingGenerationService,
    protected readonly logger: LoggerService,
  ) {}

  /** The single ledger + `ci_search.embeddings` entity_type this stage writes. */
  protected get entityType(): string {
    return this.entityTypes[0];
  }

  /**
   * The slice's rows reduced to `(id, document)` in one statement.
   *
   * Raw SQL rather than the owning domain's service, for two reasons: the
   * columns wanted are a strict subset of the row, and going through another
   * domain's barrel from inside `domains/pipeline` would couple the pipeline's
   * module graph to it for a projection. The DOCUMENT itself comes from the
   * type's shared `searchTexts` builder, so this path and the live listener
   * produce byte-identical text.
   *
   * Must be user-scoped even though the sweep already was: a slice can arrive
   * from a dead letter replayed weeks later, and re-scoping is the difference
   * between "not yours" and embedding someone else's row under this user's id.
   */
  protected abstract loadDocuments(userId: string, ids: string[]): Promise<EmbedDocumentRow[]>;

  async run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    const results = new Map<string, StageResult>();

    if (ids.length === 0) {
      return results;
    }

    if (this.honorsEmbedAllowlist && !shouldEmbedType(this.entityType)) {
      // The whole slice, one verdict: the gate is per type, not per row.
      for (const id of ids) {
        results.set(id, { outcome: 'skipped', reason: 'embed_type_disabled' });
      }

      return results;
    }

    const rows = await this.loadDocuments(ctx.userId, ids);
    const byId = new Map(rows.map((row) => [row.id, row]));

    for (const id of ids) {
      if (!byId.has(id)) {
        // Deleted, or re-owned, between the sweep and the slice. A skip, not a
        // failure: there is nothing to retry and nothing was lost.
        results.set(id, { outcome: 'skipped', reason: 'source_row_missing' });
      }
    }

    // Partition before calling Ollama. The low-value rows are decided locally,
    // cost nothing, and leave a record of the decision.
    const embeddable: Array<{ id: string; document: string }> = [];

    for (const row of rows) {
      const skip = this.skipHeuristics
        ? embedSkipReason(row.document)
        : row.document == null
          ? 'empty'
          : null;

      if (skip != null) {
        // `empty` | `too-short` | `trivial` | `url-only`, verbatim, because it
        // is already a stable greppable token and re-spelling it here would
        // make two vocabularies for one decision.
        results.set(row.id, { outcome: 'skipped', reason: skip });

        continue;
      }

      // Non-null by construction: both skip paths return a reason for null.
      embeddable.push({ id: row.id, document: row.document as string });
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
        `Embedding call failed for ${embeddable.length} ${this.entityType} rows (${reason})`,
        err instanceof Error ? err : new Error(message),
      );

      return results;
    }

    // Vectors are validated BEFORE the write, not during it. A single
    // mis-dimensioned vector would abort the whole bulk upsert — pgvector
    // rejects the cast — so one bad slot would cost every other row in the slice
    // an attempt. Screened out here, it costs only itself.
    const writable: Array<{ id: string; vector: number[]; document: string }> = [];

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

      writable.push({ id: item.id, vector: embedding, document: item.document });
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
        `Embedding upsert failed for ${writable.length} ${this.entityType} rows`,
        err instanceof Error ? err : new Error(message),
      );
    }

    return results;
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
   * Ids are v7 so rows sort by insertion time, matching every other insert into
   * this table. They are only used for brand-new rows: on conflict the existing
   * id is kept.
   */
  private async writeEmbeddings(
    userId: string,
    items: Array<{ id: string; vector: number[]; document: string }>,
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO ci_search.embeddings AS e (id, entity_type, entity_id, embedding, user_id, source_hash)
       SELECT t.id, $1, t.entity_id, t.embedding::vector, $2::uuid, t.source_hash
         FROM unnest($3::uuid[], $4::uuid[], $5::text[], $6::text[]) AS t(id, entity_id, embedding, source_hash)
       ON CONFLICT (entity_type, entity_id) DO UPDATE
          SET embedding = EXCLUDED.embedding, source_hash = EXCLUDED.source_hash, updated_at = now()`,
      [
        this.entityType,
        userId,
        items.map(() => uuidv7()),
        items.map((item) => item.id),
        // The pgvector text literal `[a,b,c]`, mirroring the entity's column
        // transformer and `EmbeddingService.upsert`.
        items.map((item) => `[${item.vector.join(',')}]`),
        // What each vector was made from, so the live listeners' unchanged-document
        // gate (`EmbeddingService.upsertDocument`) holds for rows this stage wrote.
        items.map((item) => searchDocumentHash(item.document)),
      ],
    );
  }
}
