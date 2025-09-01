"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var AuthBrokerService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthBrokerService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const crypto_1 = require("crypto");
const logger_service_1 = require("../common/logger.service");
const BrokerTokenEntity_1 = require("../entities/BrokerTokenEntity");
const OAuthProviderService_1 = require("./OAuthProviderService");
const CiServerService_1 = require("./CiServerService");
let AuthBrokerService = AuthBrokerService_1 = class AuthBrokerService {
    brokerTokenRepository;
    oauthProviderService;
    ciServerService;
    logger = new logger_service_1.LoggerService(AuthBrokerService_1.name);
    stateStore = new Map();
    constructor(brokerTokenRepository, oauthProviderService, ciServerService) {
        this.brokerTokenRepository = brokerTokenRepository;
        this.oauthProviderService = oauthProviderService;
        this.ciServerService = ciServerService;
        setInterval(() => this.cleanupExpiredStates(), 10 * 60 * 1000);
    }
    async authorize(userId, request) {
        const provider = await this.oauthProviderService.findById(request.providerId);
        if (!provider) {
            throw new common_1.BadRequestException('Invalid OAuth provider');
        }
        const state = (0, crypto_1.randomBytes)(32).toString('hex');
        const timestamp = Date.now();
        this.stateStore.set(state, {
            userId,
            providerId: request.providerId,
            timestamp,
            scopes: request.scopes,
        });
        const scopes = request.scopes && request.scopes.length > 0 ? request.scopes : provider.scopes;
        const authUrl = new URL(provider.authorizationUrl);
        authUrl.searchParams.set('client_id', provider.clientId);
        authUrl.searchParams.set('redirect_uri', provider.redirectUri);
        authUrl.searchParams.set('scope', scopes.join(' '));
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('access_type', 'offline');
        this.logger.log(`OAuth authorization initiated - User: ${userId}, Provider: ${request.providerId}`, AuthBrokerService_1.name);
        return {
            authorizationUrl: authUrl.toString(),
            state,
        };
    }
    async exchangeToken(exchange) {
        const stateData = this.stateStore.get(exchange.state);
        if (!stateData) {
            throw new common_1.UnauthorizedException('Invalid or expired state parameter');
        }
        if (Date.now() - stateData.timestamp > 15 * 60 * 1000) {
            this.stateStore.delete(exchange.state);
            throw new common_1.UnauthorizedException('State parameter expired');
        }
        if (stateData.providerId !== exchange.providerId) {
            throw new common_1.BadRequestException('Provider mismatch');
        }
        const provider = await this.oauthProviderService.findById(exchange.providerId);
        if (!provider) {
            throw new common_1.BadRequestException('Invalid OAuth provider');
        }
        try {
            const tokenResponse = await this.exchangeCodeForTokens(provider.tokenUrl, provider.clientId, provider.clientSecret, exchange.code, provider.redirectUri);
            const existingToken = await this.brokerTokenRepository.findOne({
                where: { userId: stateData.userId, providerId: exchange.providerId, active: true },
            });
            if (existingToken) {
                existingToken.accessToken = tokenResponse.access_token;
                existingToken.refreshToken = tokenResponse.refresh_token;
                existingToken.expiresAt = tokenResponse.expires_in
                    ? new Date(Date.now() + tokenResponse.expires_in * 1000)
                    : undefined;
                existingToken.scopes = stateData.scopes || provider.scopes;
                existingToken.tokenType = tokenResponse.token_type || 'Bearer';
                const updatedToken = await this.brokerTokenRepository.save(existingToken);
                await this.ciServerService.notifyTokenUpdate(stateData.userId, exchange.providerId, true);
                this.logger.log(`OAuth token updated - User: ${stateData.userId}, Token: ${updatedToken.id}`, AuthBrokerService_1.name);
                return this.tokenEntityToDto(updatedToken);
            }
            else {
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
                await this.ciServerService.notifyTokenUpdate(stateData.userId, exchange.providerId, true);
                this.logger.log(`OAuth token created - User: ${stateData.userId}, Token: ${savedToken.id}`, AuthBrokerService_1.name);
                return this.tokenEntityToDto(savedToken);
            }
        }
        catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Token exchange failed - User: ${stateData.userId}, Error: ${errorMsg}`, undefined, AuthBrokerService_1.name);
            throw new common_1.BadRequestException('Failed to exchange authorization code');
        }
        finally {
            this.stateStore.delete(exchange.state);
        }
    }
    async getUserTokens(userId) {
        const tokens = await this.brokerTokenRepository.find({
            where: { userId, active: true },
            relations: ['provider'],
            order: { createdAt: 'DESC' },
        });
        return tokens.map(token => this.tokenEntityToDto(token));
    }
    async revokeToken(userId, tokenId) {
        const token = await this.brokerTokenRepository.findOne({
            where: { id: tokenId, userId, active: true },
        });
        if (!token) {
            return false;
        }
        token.active = false;
        await this.brokerTokenRepository.save(token);
        await this.ciServerService.notifyTokenUpdate(userId, token.providerId, false);
        this.logger.log(`OAuth token revoked - User: ${userId}, Token: ${tokenId}`, AuthBrokerService_1.name);
        return true;
    }
    async exchangeCodeForTokens(tokenUrl, clientId, clientSecret, code, redirectUri) {
        const response = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
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
    tokenEntityToDto(token) {
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
    cleanupExpiredStates() {
        const now = Date.now();
        const expired = [];
        for (const [state, data] of this.stateStore.entries()) {
            if (now - data.timestamp > 15 * 60 * 1000) {
                expired.push(state);
            }
        }
        expired.forEach(state => this.stateStore.delete(state));
        if (expired.length > 0) {
            this.logger.debug(`Cleaned up ${expired.length} expired OAuth states`, AuthBrokerService_1.name);
        }
    }
};
exports.AuthBrokerService = AuthBrokerService;
exports.AuthBrokerService = AuthBrokerService = AuthBrokerService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(BrokerTokenEntity_1.BrokerTokenEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        OAuthProviderService_1.OAuthProviderService,
        CiServerService_1.CiServerService])
], AuthBrokerService);
//# sourceMappingURL=AuthBrokerService.js.map