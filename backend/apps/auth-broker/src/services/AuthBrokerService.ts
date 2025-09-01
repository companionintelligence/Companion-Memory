import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { randomBytes } from 'crypto';

import { LoggerService } from '../common/logger.service';
import { BrokerTokenEntity } from '../entities/BrokerTokenEntity';
import type { OAuthProviderService } from './OAuthProviderService';
import type { CiServerService } from './CiServerService';
import type { AuthorizeRequestDto, AuthorizeResponseDto, TokenExchangeDto, BrokerToken } from '../types';

@Injectable()
export class AuthBrokerService {
  private logger = new LoggerService(AuthBrokerService.name);

  private readonly stateStore = new Map<
    string,
    { userId: string; providerId: string; timestamp: number; scopes?: string[] }
  >();

  constructor(
    @InjectRepository(BrokerTokenEntity)
    private readonly brokerTokenRepository: Repository<BrokerTokenEntity>,
    private readonly oauthProviderService: OAuthProviderService,
    private readonly ciServerService: CiServerService,
  ) {
    // Clean up expired state entries every 10 minutes
    setInterval(() => this.cleanupExpiredStates(), 10 * 60 * 1000);
  }

  async authorize(userId: string, request: AuthorizeRequestDto): Promise<AuthorizeResponseDto> {
    const provider = await this.oauthProviderService.findById(request.providerId);
    if (!provider) {
      throw new BadRequestException('Invalid OAuth provider');
    }

    // Generate secure state parameter
    const state = randomBytes(32).toString('hex');
    const timestamp = Date.now();

    // Store state with user context
    this.stateStore.set(state, {
      userId,
      providerId: request.providerId,
      timestamp,
      scopes: request.scopes,
    });

    // Build authorization URL
    const scopes = request.scopes && request.scopes.length > 0 ? request.scopes : provider.scopes;
    const authUrl = new URL(provider.authorizationUrl);

    authUrl.searchParams.set('client_id', provider.clientId);
    authUrl.searchParams.set('redirect_uri', provider.redirectUri);
    authUrl.searchParams.set('scope', scopes.join(' '));
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('access_type', 'offline'); // Request refresh token

    this.logger.log(
      `OAuth authorization initiated - User: ${userId}, Provider: ${request.providerId}`,
      AuthBrokerService.name,
    );

    return {
      authorizationUrl: authUrl.toString(),
      state,
    };
  }

  async exchangeToken(exchange: TokenExchangeDto): Promise<BrokerToken> {
    // Validate state parameter
    const stateData = this.stateStore.get(exchange.state);
    if (!stateData) {
      throw new UnauthorizedException('Invalid or expired state parameter');
    }

    // Check if state has expired (15 minutes)
    if (Date.now() - stateData.timestamp > 15 * 60 * 1000) {
      this.stateStore.delete(exchange.state);
      throw new UnauthorizedException('State parameter expired');
    }

    // Verify provider matches
    if (stateData.providerId !== exchange.providerId) {
      throw new BadRequestException('Provider mismatch');
    }

    const provider = await this.oauthProviderService.findById(exchange.providerId);
    if (!provider) {
      throw new BadRequestException('Invalid OAuth provider');
    }

    try {
      // Exchange authorization code for tokens
      const tokenResponse = (await this.exchangeCodeForTokens(
        provider.tokenUrl,
        provider.clientId,
        provider.clientSecret,
        exchange.code,
        provider.redirectUri,
      )) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        token_type?: string;
      };

      // Check if user already has a token for this provider
      const existingToken = await this.brokerTokenRepository.findOne({
        where: { userId: stateData.userId, providerId: exchange.providerId, active: true },
      });

      if (existingToken) {
        // Update existing token
        existingToken.accessToken = tokenResponse.access_token;
        existingToken.refreshToken = tokenResponse.refresh_token;
        existingToken.expiresAt = tokenResponse.expires_in
          ? new Date(Date.now() + tokenResponse.expires_in * 1000)
          : undefined;
        existingToken.scopes = stateData.scopes || provider.scopes;
        existingToken.tokenType = tokenResponse.token_type || 'Bearer';

        const updatedToken = await this.brokerTokenRepository.save(existingToken);

        // Notify CI-Server of token update
        await this.ciServerService.notifyTokenUpdate(stateData.userId, exchange.providerId, true);

        this.logger.log(
          `OAuth token updated - User: ${stateData.userId}, Token: ${updatedToken.id}`,
          AuthBrokerService.name,
        );

        return this.tokenEntityToDto(updatedToken);
      } else {
        // Create new token
        const brokerToken = this.brokerTokenRepository.create({
          userId: stateData.userId,
          providerId: exchange.providerId,
          accessToken: tokenResponse.access_token,
          refreshToken: tokenResponse.refresh_token,
          expiresAt: tokenResponse.expires_in
            ? new Date(Date.now() + tokenResponse.expires_in * 1000)
            : undefined,
          scopes: stateData.scopes || provider.scopes,
          tokenType: tokenResponse.token_type || 'Bearer',
          active: true,
        });

        const savedToken = await this.brokerTokenRepository.save(brokerToken);

        // Notify CI-Server of token creation
        await this.ciServerService.notifyTokenUpdate(stateData.userId, exchange.providerId, true);

        this.logger.log(
          `OAuth token created - User: ${stateData.userId}, Token: ${savedToken.id}`,
          AuthBrokerService.name,
        );

        return this.tokenEntityToDto(savedToken);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Token exchange failed - User: ${stateData.userId}, Error: ${errorMsg}`,
        undefined,
        AuthBrokerService.name,
      );
      throw new BadRequestException('Failed to exchange authorization code');
    } finally {
      // Clean up state
      this.stateStore.delete(exchange.state);
    }
  }

  async getUserTokens(userId: string): Promise<BrokerToken[]> {
    const tokens = await this.brokerTokenRepository.find({
      where: { userId, active: true },
      relations: ['provider'],
      order: { createdAt: 'DESC' },
    });

    return tokens.map((token) => this.tokenEntityToDto(token));
  }

  async revokeToken(userId: string, tokenId: string): Promise<boolean> {
    const token = await this.brokerTokenRepository.findOne({
      where: { id: tokenId, userId, active: true },
    });

    if (!token) {
      return false;
    }

    token.active = false;
    await this.brokerTokenRepository.save(token);

    // Notify CI-Server of token revocation
    await this.ciServerService.notifyTokenUpdate(userId, token.providerId, false);

    this.logger.log(`OAuth token revoked - User: ${userId}, Token: ${tokenId}`, AuthBrokerService.name);

    return true;
  }

  private async exchangeCodeForTokens(
    tokenUrl: string,
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
  ) {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
    }

    return response.json();
  }

  private tokenEntityToDto(token: BrokerTokenEntity): BrokerToken {
    return {
      id: token.id,
      userId: token.userId,
      providerId: token.providerId,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      scopes: token.scopes,
      createdAt: token.createdAt,
      updatedAt: token.updatedAt,
    };
  }

  private cleanupExpiredStates(): void {
    const now = Date.now();
    const expired = [];

    for (const [state, data] of this.stateStore.entries()) {
      if (now - data.timestamp > 15 * 60 * 1000) {
        // 15 minutes
        expired.push(state);
      }
    }

    expired.forEach((state) => this.stateStore.delete(state));

    if (expired.length > 0) {
      this.logger.debug(`Cleaned up ${expired.length} expired OAuth states`, AuthBrokerService.name);
    }
  }
}
