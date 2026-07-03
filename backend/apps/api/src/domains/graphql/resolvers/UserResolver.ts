import { BadRequestException, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { NodeService } from '@ci/domains/graph';
import { PersonService } from '@ci/domains/memory';
import { UserService } from '@ci/domains/user';

import { PersonType } from '../types/PersonType';
import { UpdateCurrentUserInput } from '../types/UpdateCurrentUserInput';
import { UserType } from '../types/UserType';

/** True if `tz` is an IANA zone the JS runtime recognizes (same check HBPE/the API use elsewhere). */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());

    return true;
  } catch {
    return false;
  }
}

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => UserType)
export class UserResolver {
  constructor(
    private readonly userService: UserService,
    private readonly nodeService: NodeService,
    private readonly personService: PersonService,
  ) {}

  @Query(() => UserType, { nullable: true })
  async me(@Context() context: RequestContext): Promise<UserType | null> {
    const serviceContext = toServiceContext(context);

    const user = await this.userService.findById(serviceContext, context.userId!);

    return user ? UserType.toType(user) : null;
  }

  @Mutation(() => UserType, { nullable: true })
  async updateCurrentUser(
    @Context() context: RequestContext,
    @Args('input') input: UpdateCurrentUserInput,
  ): Promise<UserType | null> {
    if (!context.userId) {
      throw new UnauthorizedException();
    }

    const patch: { timezone?: string } = {};

    if (input.timezone !== undefined) {
      const timezone = input.timezone.trim();

      if (!isValidTimezone(timezone)) {
        // Echo the trimmed value, capped, so a huge invalid payload can't bloat the response/logs.
        throw new BadRequestException(`Invalid timezone: ${timezone.slice(0, 64)}`);
      }

      patch.timezone = timezone;
    }

    const serviceContext = toServiceContext(context);

    // Nothing to change → return current user (TypeORM's update() rejects an empty patch).
    const user =
      Object.keys(patch).length === 0
        ? await this.userService.findById(serviceContext, context.userId)
        : await this.userService.update(serviceContext, context.userId, patch);

    return user ? UserType.toType(user) : null;
  }

  @ResolveField(() => PersonType, { nullable: true })
  async entity(@Context() context: RequestContext, @Parent() parent: UserType): Promise<PersonType | null> {
    const serviceContext = toServiceContext(context);

    const node = await this.nodeService.findNodeByUserId(serviceContext, parent.__source.id);

    if (node == null || node.entityId == null) {
      return null;
    }

    const person = await this.personService.findById(serviceContext, node.entityId);

    return person ? PersonType.toType(person) : null;
  }
}
