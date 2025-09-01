"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthBrokerModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const jwt_1 = require("@nestjs/jwt");
const passport_1 = require("@nestjs/passport");
const config = __importStar(require("config"));
const AuthBrokerController_1 = require("./controllers/AuthBrokerController");
const AuthBrokerService_1 = require("./services/AuthBrokerService");
const OAuthProviderService_1 = require("./services/OAuthProviderService");
const OAuthProviderEntity_1 = require("./entities/OAuthProviderEntity");
const BrokerTokenEntity_1 = require("./entities/BrokerTokenEntity");
const CiServerService_1 = require("./services/CiServerService");
const logger_service_1 = require("./common/logger.service");
const jwt_strategy_1 = require("./auth/jwt.strategy");
let AuthBrokerModule = class AuthBrokerModule {
};
exports.AuthBrokerModule = AuthBrokerModule;
exports.AuthBrokerModule = AuthBrokerModule = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forRoot({
                type: 'postgres',
                host: config.get('database.host'),
                port: config.get('database.port'),
                username: config.get('database.username'),
                password: config.get('database.password'),
                database: config.get('database.name'),
                entities: [OAuthProviderEntity_1.OAuthProviderEntity, BrokerTokenEntity_1.BrokerTokenEntity],
                synchronize: false,
                logging: config.get('database.logging'),
            }),
            typeorm_1.TypeOrmModule.forFeature([OAuthProviderEntity_1.OAuthProviderEntity, BrokerTokenEntity_1.BrokerTokenEntity]),
            passport_1.PassportModule,
            jwt_1.JwtModule.register({
                secret: config.get('auth.jwtSecret'),
                signOptions: { expiresIn: '24h' },
            }),
        ],
        controllers: [AuthBrokerController_1.AuthBrokerController],
        providers: [
            AuthBrokerService_1.AuthBrokerService,
            OAuthProviderService_1.OAuthProviderService,
            CiServerService_1.CiServerService,
            logger_service_1.LoggerService,
            jwt_strategy_1.JwtStrategy,
        ],
    })
], AuthBrokerModule);
//# sourceMappingURL=auth-broker.module.js.map