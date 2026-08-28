import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PORTAL_TOKEN_VERIFIER } from '@ci/common/guards/PortalTokenVerifier';
import { UserModule } from '@ci/domains/user';

import { FederatedIdentityEntity } from './entities/FederatedIdentityEntity';
import { FederatedIdentityService } from './services/FederatedIdentityService';
import { PortalTokenService } from './services/PortalTokenService';

/**
 * Provides the portal-token verifier globally (under PORTAL_TOKEN_VERIFIER) so
 * JwtOrApiKeyAuthGuard — applied across every domain — can validate portal-issued
 * OIDC tokens everywhere CI-Server auth is enforced.
 */
@Global()
@Module({
  imports: [UserModule, TypeOrmModule.forFeature([FederatedIdentityEntity])],
  providers: [
    FederatedIdentityService,
    PortalTokenService,
    { provide: PORTAL_TOKEN_VERIFIER, useExisting: PortalTokenService },
  ],
  exports: [PORTAL_TOKEN_VERIFIER, FederatedIdentityService],
})
export class PortalAuthModule {}
