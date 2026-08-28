import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { ForageCorpusService } from '@ci/domains/agent';
import type { ForageTrialResponse } from '@ci/domains/predictions';

import { ForageTrialType } from '../types/ForageType';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => ForageTrialType)
export class ForageResolver {
  constructor(
    private readonly forageCorpus: ForageCorpusService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ForageResolver.name);
  }

  @Query(() => ForageTrialType, {
    nullable: true,
    description:
      'CI Forager over the user memory lake: people, places, events, search indexes, and derived forecasts',
  })
  async forage(@Context() context: RequestContext): Promise<ForageTrialType | null> {
    return this.run('Forage query failed', () => this.forageCorpus.ensure(toServiceContext(context)));
  }

  @Mutation(() => ForageTrialType, {
    nullable: true,
    description: 'Read the next lake item by expected free energy; may query indexes when the lake runs thin',
  })
  async forageSample(@Context() context: RequestContext): Promise<ForageTrialType | null> {
    return this.run('Forage sample failed', () => this.forageCorpus.sample(toServiceContext(context)));
  }

  @Mutation(() => ForageTrialType, {
    nullable: true,
    description: 'Pin a branch so the eye hunts inside it',
  })
  async foragePin(
    @Context() context: RequestContext,
    @Args('branch', { type: () => String }) branch: string,
  ): Promise<ForageTrialType | null> {
    return this.run('Forage pin failed', () => this.forageCorpus.pin(toServiceContext(context), branch));
  }

  @Mutation(() => ForageTrialType, {
    nullable: true,
    description: 'Rebuild the memory lake from people, places, events, and indexes',
  })
  async forageReset(@Context() context: RequestContext): Promise<ForageTrialType | null> {
    return this.run('Forage reset failed', () => this.forageCorpus.reset(toServiceContext(context)));
  }

  private async run(
    message: string,
    fn: () => Promise<ForageTrialResponse | null>,
  ): Promise<ForageTrialType | null> {
    if (!(await this.featureService.isFeatureEnabled('hbpe'))) {
      return null;
    }

    try {
      const trial = await fn();
      if (!trial) {
        return null;
      }

      return ForageTrialType.toType(trial);
    } catch (err) {
      this.logger.error(message, err instanceof Error ? err : new Error(String(err)));

      return null;
    }
  }
}
