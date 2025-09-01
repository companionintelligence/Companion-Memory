"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthBrokerService = exports.BrokerTokenEntity = exports.OAuthProviderEntity = exports.AuthBrokerModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const AuthBrokerController_1 = require("./controllers/AuthBrokerController");
const OAuthProviderEntity_1 = require("./entities/OAuthProviderEntity");
Object.defineProperty(exports, "OAuthProviderEntity", { enumerable: true, get: function () { return OAuthProviderEntity_1.OAuthProviderEntity; } });
const BrokerTokenEntity_1 = require("./entities/BrokerTokenEntity");
Object.defineProperty(exports, "BrokerTokenEntity", { enumerable: true, get: function () { return BrokerTokenEntity_1.BrokerTokenEntity; } });
const AuthBrokerService_1 = require("./services/AuthBrokerService");
Object.defineProperty(exports, "AuthBrokerService", { enumerable: true, get: function () { return AuthBrokerService_1.AuthBrokerService; } });
const OAuthProviderService_1 = require("./services/OAuthProviderService");
let AuthBrokerModule = class AuthBrokerModule {
};
exports.AuthBrokerModule = AuthBrokerModule;
exports.AuthBrokerModule = AuthBrokerModule = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([OAuthProviderEntity_1.OAuthProviderEntity, BrokerTokenEntity_1.BrokerTokenEntity]),
        ],
        providers: [AuthBrokerService_1.AuthBrokerService, OAuthProviderService_1.OAuthProviderService],
        controllers: [AuthBrokerController_1.AuthBrokerController],
        exports: [AuthBrokerService_1.AuthBrokerService],
    })
], AuthBrokerModule);
//# sourceMappingURL=index.js.map