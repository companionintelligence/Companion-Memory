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
const core_1 = require("@nestjs/core");
const common_1 = require("@nestjs/common");
const config = __importStar(require("config"));
const auth_broker_module_1 = require("./auth-broker.module");
const logger_service_1 = require("./common/logger.service");
async function bootstrap() {
    const app = await core_1.NestFactory.create(auth_broker_module_1.AuthBrokerModule, {
        logger: new logger_service_1.LoggerService('auth-broker'),
    });
    const express = app.getHttpAdapter().getInstance();
    express.set('trust proxy', true);
    express.disable('x-powered-by');
    app.useGlobalPipes(new common_1.ValidationPipe({ transform: true }));
    app.enableShutdownHooks();
    app.enableCors({
        origin: [
            'https://auth.companionintellience.io',
            'https://dev.companionintelligence.com',
            'http://localhost:3000',
        ],
        credentials: true,
    });
    const port = config.get('authBroker.port') || 3001;
    const host = config.get('authBroker.host') || '0.0.0.0';
    await app.listen(port, host);
    console.log(`Auth Broker Server running on ${host}:${port}`);
}
bootstrap();
//# sourceMappingURL=main.js.map