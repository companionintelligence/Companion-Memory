import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
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

    const result = await this.graphIngestService.ingest(serviceContext, {
      entities: input.entities,
      relationships: input.relationships ?? [],
    });

    return {
      success: result.errors.length === 0,
      entitiesProcessed: result.entitiesProcessed,
      relationshipsProcessed: result.relationshipsProcessed,
      errors: result.errors,
    };
  }
}
