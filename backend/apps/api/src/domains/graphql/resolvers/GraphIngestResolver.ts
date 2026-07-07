import { BadRequestException, UseGuards } from '@nestjs/common';
import { Args, Mutation, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { MAX_BULK_INPUT_SIZE } from '@ci/common/pipes';
import { GraphIngestService } from '@ci/domains/graph';

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
