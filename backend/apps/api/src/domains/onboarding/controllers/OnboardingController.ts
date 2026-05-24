import { Body, Controller, Post, UseGuards } from '@nestjs/common';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

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
    const serviceContext = toServiceContext(context);

    return this.onboardingService.onboard(serviceContext, input);
  }
}
