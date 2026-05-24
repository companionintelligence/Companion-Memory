import { Controller, Post, Body, UseGuards, ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

import { PgErrorCode } from '@ci/common/constants';
import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

import { BrowserActivityService } from '../services/BrowserActivityService';
import { CreateBrowserActivityDto, BrowserActivity, createBrowserActivitySchema } from '../types';

@Controller('browser-activity')
export class BrowserActivityController {
  constructor(private readonly browserActivityService: BrowserActivityService) {}

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post()
  async create(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(createBrowserActivitySchema))
    input: CreateBrowserActivityDto | CreateBrowserActivityDto[],
  ): Promise<BrowserActivity | BrowserActivity[]> {
    const serviceContext = toServiceContext(context);

    try {
      return await this.browserActivityService.create(serviceContext, input);
    } catch (error) {
      if (error instanceof QueryFailedError && error.driverError?.code === PgErrorCode.UNIQUE_VIOLATION) {
        throw new ConflictException('Browser activity record already exists for this time and device');
      }

      throw error;
    }
  }
}
