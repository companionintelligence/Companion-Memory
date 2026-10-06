import { BadRequestException, UseGuards } from '@nestjs/common';
import { Args, Mutation, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { MAX_BULK_INPUT_SIZE } from '@ci/common/pipes';
import { GraphIngestService } from '@ci/domains/graph';

import { GraphqlPrivacy } from '../decorators/GraphqlPrivacy';
import { BulkGraphInput } from '../types/BulkGraphInput';
import { BulkGraphPayload } from '../types/BulkGraphPayload';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver()
export class GraphIngestResolver {
  constructor(private readonly graphIngestService: GraphIngestService) {}

  /**
   * Idempotent bulk ingest of external entities + relationships (the importer's
   * knowledge graph) into the signed-in user's graph. Re-runs dedupe on the
   * linked-key and directed-relationship unique indexes.
   */
  @Mutation(() => BulkGraphPayload)
  // graphIngestService.ingest() only upserts entities/relationships INTO the caller's own graph
  // (importer -> server, never the reverse) via ON CONFLICT-based set inserts; nothing is deleted
  // and no data leaves this appliance, so this is neither destructive nor external.
  @GraphqlPrivacy({ destructive: false })
  async bulkIngestGraph(
    @Context() context: RequestContext,
    @Args('input') input: BulkGraphInput,
  ): Promise<BulkGraphPayload> {
    const serviceContext = toServiceContext(context);

    // `input` is an object arg, so the param-scoped MaxArraySizePipe the other
    // bulk-create mutations use can't apply here. Guard each array member by hand
    // with the same cap: reject an absurdly large batch before the service
    // materialises it / opens one large transaction. The 65535 bind-param limit
    // itself is handled by the service's per-statement chunking.
    const entityCount = input.entities?.length ?? 0;
    const relationshipCount = input.relationships?.length ?? 0;
    if (entityCount > MAX_BULK_INPUT_SIZE || relationshipCount > MAX_BULK_INPUT_SIZE) {
      throw new BadRequestException(
        `Input array too large: entities=${entityCount}, relationships=${relationshipCount} ` +
          `exceeds the maximum of ${MAX_BULK_INPUT_SIZE} each. ` +
          `Split the payload into batches of at most ${MAX_BULK_INPUT_SIZE}.`,
      );
    }

    // `planner` holds the owner's settings on their own Person, the autonomy dial among them, and
    // this mutation can reach that row (sourceSystem `self` is where the self Person is keyed).
    // No import carries settings, and a re-ingest merges what it is sent, so an agent calling this
    // over /api/mcp could otherwise switch tool approvals off. Settings and onboarding are the
    // dial's writers.
    const settingsWrite = input.entities?.find(
      (entity) => entity.properties && 'planner' in entity.properties,
    );
    if (settingsWrite) {
      throw new BadRequestException(
        `Entity "${settingsWrite.key}" carries a "planner" property. That key holds the owner's settings, ` +
          'which an import cannot write; change them in Settings.',
      );
    }

    const result = await this.graphIngestService.ingest(serviceContext, {
      entities: input.entities,
      relationships: input.relationships ?? [],
    });

    return {
      success: result.errors.length === 0,
      entitiesProcessed: result.entitiesProcessed,
      relationshipsProcessed: result.relationshipsProcessed,
      errors: result.errors,
      entities: result.entities,
    };
  }
}
