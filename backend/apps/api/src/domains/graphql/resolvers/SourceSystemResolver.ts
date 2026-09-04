import { UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { SourceSystemService } from '@ci/domains/memory';

@Resolver()
@UseGuards(JwtOrApiKeyAuthGuard)
export class SourceSystemResolver {
  constructor(private readonly sourceSystemService: SourceSystemService) {}

  @Query(() => [String], {
    description:
      'Distinct data sources (source_system) present for the user across every browsed table — ' +
      'events, communications, content, browser activity, receipts, products and things. ' +
      "The How picker's option list; `eventSources` is the events-only subset. " +
      'Takes the same includeTypes / excludeTypes pair as `search`, so the list is pared to the ' +
      'kinds a What selection has in play — a source no selected kind carries would select nothing.',
  })
  async sourceSystems(
    @Context() context: RequestContext,
    @Args('includeTypes', { type: () => [String], nullable: true }) includeTypes?: string[],
    @Args('excludeTypes', { type: () => [String], nullable: true }) excludeTypes?: string[],
  ): Promise<string[]> {
    return this.sourceSystemService.getDistinctSourceSystems(toServiceContext(context), {
      includeTypes: includeTypes ?? undefined,
      excludeTypes: excludeTypes ?? undefined,
    });
  }
}
