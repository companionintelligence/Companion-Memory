/**
 * This module encapsulates all authentication and session management functionalities.
 * It is responsible for handling user login, issuing JSON Web Tokens (JWTs),
 * validating tokens for protected routes, and managing user sessions.
 *
 * ### Features:
 * - **JWT-based Authentication**: Uses `@nestjs/jwt` to create and validate JWTs.
 *   The `JwtStrategy` is a Passport strategy that automatically handles token
 *   validation on incoming requests.
 * - **Session Management**: The `SessionController` and `SessionService` manage the
 *   lifecycle of user sessions, persisting them in the database via the `SessionEntity`.
 * - **User Integration**: Integrates with the `UserModule` to authenticate users against
 *   the user database.
 * - **Signup Flow**: Includes services for handling signup codes (`SignupCodeService`),
 *   linking the authentication process with user registration.
 *
 * @module AuthModule
 */

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import config from '@ci/configuration';
import { UserModule } from '@ci/domains/user';

import { ApiKeyController } from './controllers/ApiKeyController';
import { ConnectController } from './controllers/ConnectController';
import { OidcController } from './controllers/OidcController';
import { SessionController } from './controllers/SessionController';
import { SignupController } from './controllers/SignupController';
import { ApiKeyEntity } from './entities/ApiKeyEntity';
import { ConnectCodeEntity } from './entities/ConnectCodeEntity';
import { SessionEntity } from './entities/SessionEntity';
import { SignupCodeEntity } from './entities/SignupCodeEntity';
import { ConnectRequestAuthGuard } from './guards/ConnectRequestAuthGuard';
import { CsrfGuard } from './guards/CsrfGuard';
import { ApiKeyService } from './services/ApiKeyService';
import { ApiKeyStrategy } from './services/ApiKeyStrategy';
import { AuthService } from './services/AuthService';
import { ConnectCodeService } from './services/ConnectCodeService';
import { ConnectService } from './services/ConnectService';
import { CsrfService } from './services/CsrfService';
import { JwtStrategy } from './services/JwtStrategy';
import { SignupCodeService } from './services/SignupCodeService';

/**
 * @internal
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([SessionEntity, SignupCodeEntity, ApiKeyEntity, ConnectCodeEntity]),
    UserModule,
    PassportModule,
    JwtModule.register({
      secret: config.auth.jwt.authTokenSecret,
      signOptions: {
        expiresIn: config.auth.jwt.authTokenExpiration,
      },
    }),
  ],
  providers: [
    AuthService,
    JwtStrategy,
    SignupCodeService,
    CsrfGuard,
    CsrfService,
    ApiKeyService,
    ApiKeyStrategy,
    ConnectCodeService,
    ConnectService,
    ConnectRequestAuthGuard,
  ],
  controllers: [SessionController, SignupController, ApiKeyController, OidcController, ConnectController],
  exports: [SignupCodeService, ApiKeyService],
})
export class AuthModule {}

export { SignupCodeService };
export { ApiKeyService };
