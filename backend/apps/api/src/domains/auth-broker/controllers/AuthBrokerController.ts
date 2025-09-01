import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { LoggerService } from '@ci/common/services';
import type { RequestContext } from '@ci/common/types';

import { AuthBrokerService } from '../services/AuthBrokerService';
import { OAuthProviderService } from '../services/OAuthProviderService';
import type { AuthorizeRequestDto, TokenExchangeDto } from '../types';

const authorizeRequestSchema = z.object({
  providerId: z.string().uuid('Invalid provider ID'),
  scopes: z.array(z.string()).optional(),
  state: z.string().optional(),
});

const tokenExchangeSchema = z.object({
  providerId: z.string().uuid('Invalid provider ID'),
  code: z.string().min(1, 'Authorization code is required'),
  state: z.string().min(1, 'State parameter is required'),
});

@Controller('auth-broker')
export class AuthBrokerController {
  private logger = new LoggerService(AuthBrokerController.name);

  constructor(
    private readonly authBrokerService: AuthBrokerService,
    private readonly oauthProviderService: OAuthProviderService,
  ) {}

  @Get('providers')
  async getSupportedProviders() {
    return this.oauthProviderService.getSupportedProviders();
  }

  @UseGuards(JwtAuthGuard)
  @Post('authorize')
  @HttpCode(200)
  async authorize(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(authorizeRequestSchema)) body: AuthorizeRequestDto,
  ) {
    this.logger.log('OAuth authorization request', {
      userId: context.userId,
      providerId: body.providerId,
      scopes: body.scopes,
    });

    return this.authBrokerService.authorize(context.userId!, body);
  }

  @Post('callback')
  @HttpCode(200)
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('providerId') providerId: string,
  ) {
    if (!code || !state || !providerId) {
      throw new Error('Missing required callback parameters');
    }

    const exchange: TokenExchangeDto = { code, state, providerId };
    
    this.logger.log('OAuth callback received', {
      providerId,
      state,
      hasCode: !!code,
    });

    return this.authBrokerService.exchangeToken(exchange);
  }

  @UseGuards(JwtAuthGuard)
  @Get('tokens')
  async getUserTokens(@Context() context: RequestContext) {
    return this.authBrokerService.getUserTokens(context.userId!);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('tokens/:tokenId')
  @HttpCode(204)
  async revokeToken(
    @Context() context: RequestContext,
    @Param('tokenId') tokenId: string,
  ) {
    const revoked = await this.authBrokerService.revokeToken(context.userId!, tokenId);
    
    if (!revoked) {
      throw new Error('Token not found or already revoked');
    }

    this.logger.log('OAuth token revoked', {
      userId: context.userId,
      tokenId,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Post('refresh/:tokenId')
  @HttpCode(200)
  async refreshToken(
    @Context() context: RequestContext,
    @Param('tokenId') tokenId: string,
  ) {
    // TODO: Implement token refresh logic
    throw new Error('Token refresh not yet implemented');
  }
}