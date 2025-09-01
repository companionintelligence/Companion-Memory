import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthBrokerController } from './controllers/AuthBrokerController';
import { OAuthProviderEntity } from './entities/OAuthProviderEntity';
import { BrokerTokenEntity } from './entities/BrokerTokenEntity';
import { AuthBrokerService } from './services/AuthBrokerService';
import { OAuthProviderService } from './services/OAuthProviderService';

@Module({
  imports: [TypeOrmModule.forFeature([OAuthProviderEntity, BrokerTokenEntity])],
  providers: [AuthBrokerService, OAuthProviderService],
  controllers: [AuthBrokerController],
  exports: [AuthBrokerService],
})
export class AuthBrokerModule {}

// Entities
export { OAuthProviderEntity, BrokerTokenEntity };

// Services
export { AuthBrokerService };

// Types
export type {
  AuthorizeRequestDto,
  AuthorizeResponseDto,
  TokenExchangeDto,
  BrokerToken,
  OAuthProvider,
  SupportedProvider,
} from './types';
