import { UseGuards } from '@nestjs/common';
import { Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { NodeService } from '@ci/domains/graph';
import { PersonService } from '@ci/domains/memory';
import { UserService } from '@ci/domains/user';

import { PersonType } from '../types/PersonType';
import { UserType } from '../types/UserType';

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
