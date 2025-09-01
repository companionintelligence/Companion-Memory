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
var AuthBrokerController_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthBrokerController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const zod_1 = require("zod");
const logger_service_1 = require("../common/logger.service");
const AuthBrokerService_1 = require("../services/AuthBrokerService");
const OAuthProviderService_1 = require("../services/OAuthProviderService");
const authorizeRequestSchema = zod_1.z.object({
    providerId: zod_1.z.string().uuid('Invalid provider ID'),
    scopes: zod_1.z.array(zod_1.z.string()).optional(),
    state: zod_1.z.string().optional(),
});
const tokenExchangeSchema = zod_1.z.object({
    providerId: zod_1.z.string().uuid('Invalid provider ID'),
    code: zod_1.z.string().min(1, 'Authorization code is required'),
    state: zod_1.z.string().min(1, 'State parameter is required'),
});
let AuthBrokerController = AuthBrokerController_1 = class AuthBrokerController {
    authBrokerService;
    oauthProviderService;
    logger = new logger_service_1.LoggerService(AuthBrokerController_1.name);
    constructor(authBrokerService, oauthProviderService) {
        this.authBrokerService = authBrokerService;
        this.oauthProviderService = oauthProviderService;
    }
    async getSupportedProviders() {
        return this.oauthProviderService.getSupportedProviders();
    }
    async authorize(req, body) {
        const result = authorizeRequestSchema.safeParse(body);
        if (!result.success) {
            throw new common_1.BadRequestException('Invalid request data');
        }
        const userId = req.user?.userId;
        if (!userId) {
            throw new common_1.UnauthorizedException('User not authenticated');
        }
        this.logger.log(`OAuth authorization request - User: ${userId}, Provider: ${body.providerId}`, AuthBrokerController_1.name);
        return this.authBrokerService.authorize(userId, body);
    }
    async callback(code, state, providerId) {
        if (!code || !state || !providerId) {
            throw new common_1.BadRequestException('Missing required callback parameters');
        }
        const exchange = { code, state, providerId };
        const result = tokenExchangeSchema.safeParse(exchange);
        if (!result.success) {
            throw new common_1.BadRequestException('Invalid callback parameters');
        }
        this.logger.log(`OAuth callback received - Provider: ${providerId}, State: ${state}`, AuthBrokerController_1.name);
        return this.authBrokerService.exchangeToken(exchange);
    }
    async getUserTokens(req) {
        const userId = req.user?.userId;
        if (!userId) {
            throw new common_1.UnauthorizedException('User not authenticated');
        }
        return this.authBrokerService.getUserTokens(userId);
    }
    async revokeToken(req, tokenId) {
        const userId = req.user?.userId;
        if (!userId) {
            throw new common_1.UnauthorizedException('User not authenticated');
        }
        const revoked = await this.authBrokerService.revokeToken(userId, tokenId);
        if (!revoked) {
            throw new common_1.BadRequestException('Token not found or already revoked');
        }
        this.logger.log(`OAuth token revoked - User: ${userId}, Token: ${tokenId}`, AuthBrokerController_1.name);
    }
    async refreshToken(req, tokenId) {
        throw new common_1.BadRequestException('Token refresh not yet implemented');
    }
};
exports.AuthBrokerController = AuthBrokerController;
__decorate([
    (0, common_1.Get)('providers'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AuthBrokerController.prototype, "getSupportedProviders", null);
__decorate([
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt')),
    (0, common_1.Post)('authorize'),
    (0, common_1.HttpCode)(200),
    (0, common_1.UsePipes)(new common_1.ValidationPipe({ transform: true })),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AuthBrokerController.prototype, "authorize", null);
__decorate([
    (0, common_1.Post)('callback'),
    (0, common_1.HttpCode)(200),
    (0, common_1.UsePipes)(new common_1.ValidationPipe({ transform: true })),
    __param(0, (0, common_1.Query)('code')),
    __param(1, (0, common_1.Query)('state')),
    __param(2, (0, common_1.Query)('providerId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], AuthBrokerController.prototype, "callback", null);
__decorate([
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt')),
    (0, common_1.Get)('tokens'),
    __param(0, (0, common_1.Request)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AuthBrokerController.prototype, "getUserTokens", null);
__decorate([
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt')),
    (0, common_1.Delete)('tokens/:tokenId'),
    (0, common_1.HttpCode)(204),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Param)('tokenId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AuthBrokerController.prototype, "revokeToken", null);
__decorate([
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt')),
    (0, common_1.Post)('refresh/:tokenId'),
    (0, common_1.HttpCode)(200),
    __param(0, (0, common_1.Request)()),
    __param(1, (0, common_1.Param)('tokenId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], AuthBrokerController.prototype, "refreshToken", null);
exports.AuthBrokerController = AuthBrokerController = AuthBrokerController_1 = __decorate([
    (0, common_1.Controller)('auth-broker'),
    __metadata("design:paramtypes", [AuthBrokerService_1.AuthBrokerService,
        OAuthProviderService_1.OAuthProviderService])
], AuthBrokerController);
//# sourceMappingURL=AuthBrokerController.js.map