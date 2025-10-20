import { Body, Controller, Post, UseGuards } from '@nestjs/common';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { RequestContext } from '@ci/common/types';

import { OnboardingService } from '../services/OnboardingService';
import { type OnboardingInput, OnboardingInputSchema } from '../types';

@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @UseGuards(JwtAuthGuard)
  @Post('onboard')
  onboard(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(OnboardingInputSchema)) input: OnboardingInput,
  ) {
    return this.onboardingService.onboard(context, input);
  }
}
