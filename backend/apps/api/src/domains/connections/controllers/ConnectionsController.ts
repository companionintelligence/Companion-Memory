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
  providerId: z.string().uuid('Invalid provider ID').optional(),
  active: z.boolean().optional(),
  clientid: z.string().optional(),
  clientkey: z.string().optional(),
  clientsecret: z.string().optional(),
  schedule: z.string().optional(),
});

@Controller('connections')
export class ConnectionsController {
  private readonly frontendUrl = process.env.FRONTEND_URL || 'http://127.0.0.1:5173';

  constructor(private readonly connectionService: ConnectionService) {}

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('scope') scope: string,
    @Res() res: Response,
  ) {
    console.log('OAuth callback received:', { code, state, scope });
    
    // If no code or state, this might be a test request
    if (!code || !state) {
      console.log('No code or state provided, returning test response');
      return res.json({ 
        message: 'OAuth callback endpoint is working',
        received: { code, state, scope },
        frontendUrl: this.frontendUrl 
      });
    }
    
    try {
      // Create a minimal context for the callback
      const context: RequestContext = {
        query: { code, state, scope },
      };

      const result = await this.connectionService.callback(context);

      console.log('OAuth callback result:', result);

      // Return both the redirect URL and the connection data
      // This allows the frontend to handle both the redirect and make API calls
      const responseData = {
        redirect: result.redirect,
        connection: result.connection,
        success: true,
        connectionId: result.connectionId,
      };

      // If the service returns a redirect URL, include it in the response
      if (result.redirect) {
        console.log('Including redirect URL in response:', result.redirect);
        return res.json(responseData);
      }

      // Otherwise return the result as JSON
      return res.json(responseData);
    } catch (error) {
      // Log the error and return error response
      console.error('OAuth callback error:', error);

      const errorResponse = {
        success: false,
        error: 'Authentication failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        redirect: `${this.frontendUrl}/connections?oauth=error&message=${encodeURIComponent('Authentication failed')}`,
      };

      return res.json(errorResponse);
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/connect')
  async connect(@Context() context: RequestContext, @Param('id') id: string) {
    return this.connectionService.connect(context, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('callback/complete')
  async completeCallback(
    @Context() context: RequestContext,
    @Body() body: { connectionId: string; success: boolean; error?: string },
  ) {
    console.log('Completing OAuth callback:', body);
    
    try {
      if (body.success) {
        // Get the updated connection data
        const connection = await this.connectionService.findOne(context, body.connectionId);
        return {
          success: true,
          connection,
          message: 'OAuth authentication completed successfully',
        };
      } else {
        return {
          success: false,
          error: body.error || 'OAuth authentication failed',
          message: 'Failed to complete OAuth authentication',
        };
      }
    } catch (error) {
      console.error('Error completing OAuth callback:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: 'Failed to complete OAuth authentication',
      };
    }
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
