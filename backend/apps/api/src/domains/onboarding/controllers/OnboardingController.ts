import { Controller, UseGuards, NotFoundException, Post } from '@nestjs/common';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { RequestContext } from '@ci/common/types';
import { UserService } from '@ci/domains/user';

@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly userService: UserService) {}

  @UseGuards(JwtAuthGuard)
  @Post('onboard')
  async onboard(@Context() context: RequestContext) {
    const userId = context.userId;

    if (userId == null) {
      throw new NotFoundException();
    }

    await this.userService.onboard(userId);

    return {
      onboarded: true,
    };
  }
}
