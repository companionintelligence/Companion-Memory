import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
  Res,
  Query,
} from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import type { RequestContext } from '@ci/common/types';

import { ConnectionService } from '../services/ConnectionService';
import type { CreateConnectionDto, UpdateConnectionDto } from '../types';

const createConnectionSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  providerId: z.string().uuid('Invalid provider ID'),
  clientid: z.string().optional(),
  clientkey: z.string().optional(),
  clientsecret: z.string().optional(),
  schedule: z.string().optional(),
});

const updateConnectionSchema = z.object({
  name: z.string().min(1, 'Name is required').optional(),
  active: z.boolean().optional(),
  clientid: z.string().optional(),
  clientkey: z.string().optional(),
  clientsecret: z.string().optional(),
  schedule: z.string().optional(),
});

@Controller('connections')
export class ConnectionsController {
  constructor(private readonly connectionService: ConnectionService) {}

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('scope') scope: string,
    @Res() res: Response,
  ) {
    try {
      // Create a minimal context for the callback
      const context: RequestContext = {
        query: { code, state, scope },
      };

      const result = await this.connectionService.callback(context);

      // If the service returns a redirect URL, perform the redirect
      if (result.redirect) {
        return res.redirect(302, result.redirect);
      }

      // Otherwise return the result as JSON
      return res.json(result);
    } catch (error) {
      // Log the error and redirect to frontend with error
      console.error('OAuth callback error:', error);
      const frontendUrl = process.env.FRONTEND_URL || 'http://dev.companionintelligence.com';

      return res.redirect(
        302,
        `${frontendUrl}/connections?oauth=error&message=${encodeURIComponent('Authentication failed')}`,
      );
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/connect')
  async connect(@Context() context: RequestContext, @Param('id') id: string) {
    return this.connectionService.connect(context, id);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll(@Context() context: RequestContext) {
    return this.connectionService.findAll(context);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Context() context: RequestContext, @Param('id') id: string) {
    return this.connectionService.findOne(context, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(createConnectionSchema)) input: CreateConnectionDto,
  ) {
    return this.connectionService.create(context, input);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async update(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Body(new ValidationPipe(updateConnectionSchema)) input: UpdateConnectionDto,
  ) {
    return this.connectionService.update(context, id, input);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/activate')
  @HttpCode(200)
  async activate(@Context() context: RequestContext, @Param('id') id: string) {
    return this.connectionService.activate(context, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/deactivate')
  @HttpCode(200)
  async deactivate(@Context() context: RequestContext, @Param('id') id: string) {
    return this.connectionService.deactivate(context, id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(204)
  async delete(@Context() context: RequestContext, @Param('id') id: string) {
    await this.connectionService.delete(context, id);
  }
}
