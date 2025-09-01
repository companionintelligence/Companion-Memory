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
exports.OAuthProviderEntity = void 0;
const typeorm_1 = require("typeorm");
let OAuthProviderEntity = class OAuthProviderEntity {
    id;
    name;
    displayName;
    clientId;
    clientSecret;
    authorizationUrl;
    tokenUrl;
    scopes;
    redirectUri;
    active;
    logoUrl;
    description;
    createdAt;
    updatedAt;
};
exports.OAuthProviderEntity = OAuthProviderEntity;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], OAuthProviderEntity.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ unique: true }),
    (0, typeorm_1.Index)(),
    __metadata("design:type", String)
], OAuthProviderEntity.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'display_name' }),
    __metadata("design:type", String)
], OAuthProviderEntity.prototype, "displayName", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'client_id' }),
    __metadata("design:type", String)
], OAuthProviderEntity.prototype, "clientId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'client_secret' }),
    __metadata("design:type", String)
], OAuthProviderEntity.prototype, "clientSecret", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'authorization_url' }),
    __metadata("design:type", String)
], OAuthProviderEntity.prototype, "authorizationUrl", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'token_url' }),
    __metadata("design:type", String)
], OAuthProviderEntity.prototype, "tokenUrl", void 0);
__decorate([
    (0, typeorm_1.Column)('json'),
    __metadata("design:type", Array)
], OAuthProviderEntity.prototype, "scopes", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'redirect_uri' }),
    __metadata("design:type", String)
], OAuthProviderEntity.prototype, "redirectUri", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: true }),
    __metadata("design:type", Boolean)
], OAuthProviderEntity.prototype, "active", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'logo_url', nullable: true }),
    __metadata("design:type", String)
], OAuthProviderEntity.prototype, "logoUrl", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], OAuthProviderEntity.prototype, "description", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)({ name: 'created_at' }),
    __metadata("design:type", Date)
], OAuthProviderEntity.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)({ name: 'updated_at' }),
    __metadata("design:type", Date)
], OAuthProviderEntity.prototype, "updatedAt", void 0);
exports.OAuthProviderEntity = OAuthProviderEntity = __decorate([
    (0, typeorm_1.Entity)('oauth_providers')
], OAuthProviderEntity);
//# sourceMappingURL=OAuthProviderEntity.js.map