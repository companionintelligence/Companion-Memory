import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

import { OnboardingService } from '../services/OnboardingService';
import {
  type OnboardingInput,
  OnboardingInputSchema,
  type OnboardingProgressInput,
  OnboardingProgressInputSchema,
} from '../types';

@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  // The phone trades its login JWT for a durable API key and never holds a
  // bearer after that. A JWT-only guard 401s every one of these calls from
  // the native app: progress reads and writes fail quietly, and the last
  // step's POST is the one the owner actually sees ("Could not finish setup").
  // Desktop still presents a JWT, which this guard accepts too.
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('progress')
  getProgress(@Context() context: RequestContext) {
    return this.onboardingService.getProgress(toServiceContext(context));
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Put('progress')
  saveProgress(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(OnboardingProgressInputSchema)) input: OnboardingProgressInput,
  ) {
    return this.onboardingService.saveProgress(toServiceContext(context), input);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post('onboard')
  onboard(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(OnboardingInputSchema)) input: OnboardingInput,
  ) {
    const serviceContext = toServiceContext(context);

    return this.onboardingService.onboard(serviceContext, input);
  }
}
