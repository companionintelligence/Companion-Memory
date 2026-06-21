import { Global, Module } from '@nestjs/common';

import { PORTAL_TOKEN_VERIFIER } from '@ci/common/guards/PortalTokenVerifier';
import { UserModule } from '@ci/domains/user';

import { PortalTokenService } from './services/PortalTokenService';

/**
 * Provides the portal-token verifier globally (under PORTAL_TOKEN_VERIFIER) so
 * JwtOrApiKeyAuthGuard — applied across every domain — can validate portal-issued
 * OIDC tokens everywhere CI-Server auth is enforced.
 */
@Global()
@Module({
  imports: [UserModule],
  providers: [PortalTokenService, { provide: PORTAL_TOKEN_VERIFIER, useExisting: PortalTokenService }],
  exports: [PORTAL_TOKEN_VERIFIER],
})
export class PortalAuthModule {}
