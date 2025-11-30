import { NotFoundException, UseGuards } from '@nestjs/common';
import { Query, Resolver } from '@nestjs/graphql';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { RequestContext } from '@ci/common/types';
import { UserService } from '@ci/domains/user';

import { UserType } from '../types/UserType';

@UseGuards(JwtAuthGuard)
@Resolver(() => UserType)
export class UserResolver {
  constructor(private readonly userService: UserService) {}

  @Query(() => UserType, { nullable: true })
  async me(@Context() context: RequestContext): Promise<UserType> {
    const user = await this.userService.findOne(context.userId!);

    if (user == null) {
      throw new NotFoundException();
    }

    return UserType.fromEntity(user);
  }
}
