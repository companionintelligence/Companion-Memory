import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ItemRelationshipService } from '@ci/domains/graph';

import { BulkItemRelationshipResult } from '../types/BulkItemRelationshipResult';
import { ItemRelationshipInput } from '../types/ItemRelationshipInput';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver()
export class ItemRelationshipResolver {
  constructor(private readonly itemRelationshipService: ItemRelationshipService) {}

  /**
   * Idempotent, set-based bulk ingest of item↔item edges (email→attachment,
   * photo→album) from the importer. Endpoints are referenced by their provenance
   * triple; the whole array lands in one INSERT ... ON CONFLICT DO NOTHING, so
   * re-sends dedup on (owner, from-triple, to-triple, relation). `user_id` comes
   * from the authenticated context, like every other memory mutation.
   */
  @Mutation(() => BulkItemRelationshipResult)
  async bulkIngestItemRelationships(
    @Context() context: RequestContext,
    @Args('input', { type: () => [ItemRelationshipInput] }) input: ItemRelationshipInput[],
  ): Promise<BulkItemRelationshipResult> {
    const serviceContext = toServiceContext(context);

    return this.itemRelationshipService.createMany(serviceContext, input);
  }
}
