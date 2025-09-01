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
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrokerTokenEntity = void 0;
const typeorm_1 = require("typeorm");
const OAuthProviderEntity_1 = require("./OAuthProviderEntity");
let BrokerTokenEntity = class BrokerTokenEntity {
    id;
    userId;
    providerId;
    accessToken;
    refreshToken;
    expiresAt;
    scopes;
    tokenType;
    active;
    createdAt;
    updatedAt;
    provider;
};
exports.BrokerTokenEntity = BrokerTokenEntity;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], BrokerTokenEntity.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'user_id' }),
    (0, typeorm_1.Index)(),
    __metadata("design:type", String)
], BrokerTokenEntity.prototype, "userId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'provider_id' }),
    (0, typeorm_1.Index)(),
    __metadata("design:type", String)
], BrokerTokenEntity.prototype, "providerId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'access_token' }),
    __metadata("design:type", String)
], BrokerTokenEntity.prototype, "accessToken", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'refresh_token', nullable: true }),
    __metadata("design:type", String)
], BrokerTokenEntity.prototype, "refreshToken", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'expires_at', nullable: true }),
    __metadata("design:type", Date)
], BrokerTokenEntity.prototype, "expiresAt", void 0);
__decorate([
    (0, typeorm_1.Column)('json'),
    __metadata("design:type", Array)
], BrokerTokenEntity.prototype, "scopes", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'token_type', default: 'Bearer' }),
    __metadata("design:type", String)
], BrokerTokenEntity.prototype, "tokenType", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: true }),
    __metadata("design:type", Boolean)
], BrokerTokenEntity.prototype, "active", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)({ name: 'created_at' }),
    __metadata("design:type", Date)
], BrokerTokenEntity.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)({ name: 'updated_at' }),
    __metadata("design:type", Date)
], BrokerTokenEntity.prototype, "updatedAt", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => OAuthProviderEntity_1.OAuthProviderEntity),
    (0, typeorm_1.JoinColumn)({ name: 'provider_id' }),
    __metadata("design:type", OAuthProviderEntity_1.OAuthProviderEntity)
], BrokerTokenEntity.prototype, "provider", void 0);
exports.BrokerTokenEntity = BrokerTokenEntity = __decorate([
    (0, typeorm_1.Entity)('broker_tokens'),
    (0, typeorm_1.Index)(['userId', 'providerId'], { unique: true })
], BrokerTokenEntity);
//# sourceMappingURL=BrokerTokenEntity.js.map