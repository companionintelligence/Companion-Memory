import { 
  Body, 
  Controller, 
  Delete, 
  Get, 
  HttpCode, 
  Param, 
  Post, 
  Query, 
  UseGuards, 
  UsePipes,
  ValidationPipe as NestValidationPipe,
  Request,
  UnauthorizedException,
  BadRequestException
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { z } from 'zod';

import { LoggerService } from '../common/logger.service';
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

  @UseGuards(AuthGuard('jwt'))
  @Post('authorize')
  @HttpCode(200)
  @UsePipes(new NestValidationPipe({ transform: true }))
  async authorize(
    @Request() req: any,
    @Body() body: AuthorizeRequestDto,
  ) {
    const result = authorizeRequestSchema.safeParse(body);
    if (!result.success) {
      throw new BadRequestException('Invalid request data');
    }

    const userId = req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('User not authenticated');
    }

    this.logger.log(`OAuth authorization request - User: ${userId}, Provider: ${body.providerId}`, AuthBrokerController.name);

    return this.authBrokerService.authorize(userId, body);
  }

  @Post('callback')
  @HttpCode(200)
  @UsePipes(new NestValidationPipe({ transform: true }))
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('providerId') providerId: string,
  ) {
    if (!code || !state || !providerId) {
      throw new BadRequestException('Missing required callback parameters');
    }

    const exchange: TokenExchangeDto = { code, state, providerId };
    
    const result = tokenExchangeSchema.safeParse(exchange);
    if (!result.success) {
      throw new BadRequestException('Invalid callback parameters');
    }
    
    this.logger.log(`OAuth callback received - Provider: ${providerId}, State: ${state}`, AuthBrokerController.name);

    return this.authBrokerService.exchangeToken(exchange);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('tokens')
  async getUserTokens(@Request() req: any) {
    const userId = req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.authBrokerService.getUserTokens(userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @Delete('tokens/:tokenId')
  @HttpCode(204)
  async revokeToken(
    @Request() req: any,
    @Param('tokenId') tokenId: string,
  ) {
    const userId = req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('User not authenticated');
    }

    const revoked = await this.authBrokerService.revokeToken(userId, tokenId);
    
    if (!revoked) {
      throw new BadRequestException('Token not found or already revoked');
    }

    this.logger.log(`OAuth token revoked - User: ${userId}, Token: ${tokenId}`, AuthBrokerController.name);
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('refresh/:tokenId')
  @HttpCode(200)
  async refreshToken(
    @Request() req: any,
    @Param('tokenId') tokenId: string,
  ) {
    // TODO: Implement token refresh logic
    throw new BadRequestException('Token refresh not yet implemented');
  }
}