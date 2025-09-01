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
var OAuthProviderService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.OAuthProviderService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const logger_service_1 = require("../common/logger.service");
const OAuthProviderEntity_1 = require("../entities/OAuthProviderEntity");
let OAuthProviderService = OAuthProviderService_1 = class OAuthProviderService {
    oauthProviderRepository;
    logger = new logger_service_1.LoggerService(OAuthProviderService_1.name);
    constructor(oauthProviderRepository) {
        this.oauthProviderRepository = oauthProviderRepository;
    }
    async findAll() {
        return this.oauthProviderRepository.find({
            where: { active: true },
            order: { name: 'ASC' },
        });
    }
    async findById(id) {
        return this.oauthProviderRepository.findOne({
            where: { id, active: true },
        });
    }
    async findByName(name) {
        return this.oauthProviderRepository.findOne({
            where: { name, active: true },
        });
    }
    async getSupportedProviders() {
        const providers = await this.findAll();
        return providers.map(provider => ({
            id: provider.id,
            name: provider.name,
            displayName: provider.displayName,
            scopes: provider.scopes,
            logoUrl: provider.logoUrl,
            description: provider.description,
        }));
    }
    async createProvider(providerData) {
        const provider = this.oauthProviderRepository.create({
            ...providerData,
            active: true,
        });
        const savedProvider = await this.oauthProviderRepository.save(provider);
        this.logger.log(`OAuth provider created - ${savedProvider.name}`, OAuthProviderService_1.name);
        return savedProvider;
    }
    async updateProvider(id, updates) {
        const provider = await this.findById(id);
        if (!provider) {
            return null;
        }
        Object.assign(provider, updates);
        const updatedProvider = await this.oauthProviderRepository.save(provider);
        this.logger.log(`OAuth provider updated - ${id}`, OAuthProviderService_1.name);
        return updatedProvider;
    }
    async deactivateProvider(id) {
        const result = await this.oauthProviderRepository.update(id, { active: false });
        if (result.affected && result.affected > 0) {
            this.logger.log(`OAuth provider deactivated - ${id}`, OAuthProviderService_1.name);
            return true;
        }
        return false;
    }
};
exports.OAuthProviderService = OAuthProviderService;
exports.OAuthProviderService = OAuthProviderService = OAuthProviderService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(OAuthProviderEntity_1.OAuthProviderEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], OAuthProviderService);
//# sourceMappingURL=OAuthProviderService.js.map