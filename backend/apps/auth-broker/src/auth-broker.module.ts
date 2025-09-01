import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import * as config from 'config';

import { AuthBrokerController } from './controllers/AuthBrokerController';
import { AuthBrokerService } from './services/AuthBrokerService';
import { OAuthProviderService } from './services/OAuthProviderService';
import { OAuthProviderEntity } from './entities/OAuthProviderEntity';
import { BrokerTokenEntity } from './entities/BrokerTokenEntity';
import { CiServerService } from './services/CiServerService';
import { LoggerService } from './common/logger.service';
import { JwtStrategy } from './auth/jwt.strategy';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: config.get('database.host'),
      port: config.get('database.port'),
      username: config.get('database.username'),
      password: config.get('database.password'),
      database: config.get('database.name'),
      entities: [OAuthProviderEntity, BrokerTokenEntity],
      synchronize: false,
      logging: config.get('database.logging'),
    }),
    TypeOrmModule.forFeature([OAuthProviderEntity, BrokerTokenEntity]),
    PassportModule,
    JwtModule.register({
      secret: config.get('auth.jwtSecret'),
      signOptions: { expiresIn: '24h' },
    }),
  ],
  controllers: [AuthBrokerController],
  providers: [AuthBrokerService, OAuthProviderService, CiServerService, LoggerService, JwtStrategy],
})
export class AuthBrokerModule {}
