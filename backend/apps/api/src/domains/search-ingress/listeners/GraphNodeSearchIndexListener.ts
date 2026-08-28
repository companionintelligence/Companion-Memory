import { Injectable } from '@nestjs/common';

import { EmbeddingGenerationService, embedSkipReason, normalizeEmbeddableType } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { type EventPayloads, Events, OnEvent } from '@ci/domains/events';
import { type IndexableEntity } from '@ci/domains/search-next';

import { EmbeddingService } from '../services/EmbeddingService';
import { VectorService } from '../services/VectorService';
import { type WeightedText } from '../types';

/**
 * Search-vocabulary types this listener is allowed to index, ALLOWLIST rather
 * than denylist, on purpose — read on before adding to it.
 *
 * `GraphEventService.upsertNode` — reached only through `WriteKnowledgeTool`,
 * its sole caller — writes ONE row: `ci.entities`. It never creates a matching
 * detail row in whatever table actually backs a search-vocabulary type
 * (`ci.events`, `ci.objects`, `ci.content`, `ci.files`, `ci.notes`, ...). So a
 * graph-authored node is resolvable by `EntityResolutionService` ONLY for types
 * whose data lives entirely in `ci.entities` — which today is none of them:
 *
 *  - `person` / `place` / `concept` DO live there alone, but are already
 *    indexed by `GraphEventListener.emitSearchIndexEvent` re-emitting a
 *    per-type `*Created`/`*UpdatedEvent`, which the existing
 *    `PersonSearchIndexListener` etc. consume to build a richer,
 *    properties-aware document. Indexing them again here would just pay for a
 *    second, poorer embedding of the same node.
 *  - EVERY OTHER embeddable type — event, item, content, file, file-chunk,
 *    note, thread, communication, browser-activity, answer — is backed by a
 *    real detail table a graph-only write never populates. Indexing one of
 *    these here would write a `ci_search.vectors` candidate (a real DB row,
 *    plus a paid embedding call) that `EntityResolutionService.resolve()` can
 *    never turn back into a result: its per-type `findByIds` queries the
 *    detail table, finds nothing, and the row silently vanishes at read time.
 *    That is worse than not indexing: it burns embedding cost on something
 *    provably unfindable, and it makes `ci_search.vectors` claim searchability
 *    it does not have.
 *
 * Hence: allowlist, defaulting empty, so a new embeddable type added anywhere
 * upstream costs nothing here until someone deliberately opts it in — the
 * failure mode of an unmaintained DENYLIST (forgetting to add a new
 * unresolvable type) is silent data-integrity damage; the failure mode of an
 * unmaintained ALLOWLIST is merely "not indexed yet".
 *
 * To add an entry: first make it true. Either (a) give
 * `EntityResolutionService` a path that reads `ci.entities` directly for a
 * graph-authored node of that type instead of requiring the detail-table row,
 * or (b) make `GraphEventService.upsertNode` create the real detail row when
 * the caller names that type. Only once one of those exists does adding the
 * type here do anything but pay embedding cost for an unreachable row.
 */
const RESOLVABLE_FROM_ENTITIES_ALONE: ReadonlySet<string> = new Set([]);

/**
 * Indexes a graph node written through `GraphEventService.upsertNode`, for
 * search-vocabulary types that are both (a) not already indexed by a per-type
 * `*SearchIndexListener` and (b) actually resolvable back to a row from what a
 * graph-only write produces — see {@link RESOLVABLE_FROM_ENTITIES_ALONE}.
 *
 * That set is empty today, so this listener currently indexes nothing. It
 * stays registered as the extension point for the day one of the two fixes
 * described above lands and a type genuinely qualifies — at which point
 * enabling it is a one-line addition to the allowlist, not a new listener.
 */
@Injectable()
export class GraphNodeSearchIndexListener {
  constructor(
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorService: VectorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GraphNodeSearchIndexListener.name);
  }

  @OnEvent(Events.GRAPH_NODE_UPSERTED, { queue: 'search-index' })
  async indexGraphNode(payload: EventPayloads[Events.GRAPH_NODE_UPSERTED]) {
    const { node } = payload;

    if (!node?.entityId || !payload.ownerId) {
      return;
    }

    const searchType = normalizeEmbeddableType(node.entityType);

    if (searchType == null || !RESOLVABLE_FROM_ENTITIES_ALONE.has(searchType)) {
      this.logger.debug('Skipping graph node search indexing', {
        entityId: node.entityId,
        entityType: node.entityType ?? null,
        reason:
          searchType == null
            ? 'type has no search representation'
            : 'not resolvable from a graph-only entities row, see RESOLVABLE_FROM_ENTITIES_ALONE',
      });

      return;
    }

    const entityType = searchType as IndexableEntity;
    const name = (node.name ?? '').trim();
    const description = (node.description ?? '').trim();
    const explicit = (node.searchContent ?? '').trim();

    const searchableText: WeightedText[] = [];

    if (name) {
      searchableText.push({ text: name, weight: 10 });
    }

    if (description) {
      searchableText.push({ text: description, weight: 5 });
    }

    if (explicit && explicit !== name && explicit !== description) {
      searchableText.push({ text: explicit, weight: 2 });
    }

    if (searchableText.length === 0) {
      this.logger.log('Graph node has no search content, skipping indexing', {
        entityId: node.entityId,
        entityType,
      });

      return;
    }

    const context = { userId: payload.ownerId };

    // Keyword indexing first, and unconditionally: the tsvector is what makes the
    // node a search CANDIDATE, and it is deliberately not gated by the
    // embeddability quality bar (see `@ci/common/embeddings`).
    await this.vectorService.upsert(context, {
      entityType,
      entityId: node.entityId,
      searchableText,
    });

    this.logger.log('Generated tsvector for graph node', {
      entityId: node.entityId,
      entityType,
    });

    const searchDocument = searchableText.map((part) => part.text).join(' ');
    const skipReason = embedSkipReason(searchDocument);

    if (skipReason != null) {
      this.logger.log('Skipping embedding for graph node', {
        entityId: node.entityId,
        entityType,
        reason: skipReason,
      });

      return;
    }

    const embedding = await this.embeddingGenerationService.generateEmbedding(searchDocument);

    await this.embeddingService.upsert(context, {
      entityType,
      entityId: node.entityId,
      embedding,
    });

    this.logger.log('Generated embedding for graph node', {
      entityId: node.entityId,
      entityType,
    });
  }
}
