import type { ApiKeyCapability } from '@ci/common/decorators';

/**
 * DI seam for portal-token validation. Lives in `common` (no domain imports) so
 * JwtOrApiKeyAuthGuard can depend on it without creating a guard → auth → user →
 * guard import cycle. The implementation (PortalTokenService) is provided under
 * this token by PortalAuthModule.
 */
export const PORTAL_TOKEN_VERIFIER = 'PORTAL_TOKEN_VERIFIER';

/**
 * A verified Portal bearer and what it may do here.
 *
 * A Portal token used to carry the user's full authority on every Memory that trusts the Portal.
 * Now the authority depends on which client the token was issued to and whether it was addressed
 * to this appliance; `PortalTokenService` decides, and the guards enforce it:
 *
 * - `limits` null is the user's full authority, like a session. Otherwise the guards set
 *   `apiKeyScopes`/`apiKeyCapability` from it and run the api-key enforcement, so the bearer is
 *   confined exactly as a key with those scopes would be.
 * - `credentialRoutes` false refuses it at `JwtOrPortalAuthGuard`: no key minting, no MCP server
 *   configuration.
 * - `admin` false refuses it at `AdminOnlyGuard` and `ApplianceAdminGuard`, whatever the user's role.
 */
export interface PortalPrincipal {
  /**
   * The local user. `role` is part of the contract: the guards assign this object to
   * `request.user`, and `AdminOnlyGuard` reads `request.user.role`. Widened rather than typed as
   * `User`: guards in this directory stay free of `@ci/domains` imports.
   */
  user: { id: string; role?: string };
  limits: { scopes: string[]; capability: ApiKeyCapability } | null;
  credentialRoutes: boolean;
  admin: boolean;
}

/** What the guards leave on the request for a Portal principal, for the admin guards to read. */
export interface PortalPrincipalMarker {
  portalPrincipal?: { admin: boolean };
}

export interface PortalTokenVerifier {
  /** Whether portal-brokered OIDC auth is enabled. */
  readonly enabled: boolean;
  /**
   * Verify a portal-issued Bearer token and return the user it resolves to with the authority it
   * carries here, or null if it is not a valid portal token for this appliance.
   */
  verifyAndProvision(token: string): Promise<PortalPrincipal | null>;
  /**
   * Verify a portal token's claims WITHOUT provisioning a local user. Used by
   * the peer-ask surface, where the caller is another Companion rather than a
   * local user: provisioning there would mint a shadow account on every box a
   * portal user can reach.
   *
   * `audience`, when supplied, REPLACES the default first-party audience list.
   * The peer surface passes this box's own audience so a token minted for a
   * different box cannot be replayed here — without it, any token bearing any
   * first-party audience would be accepted by every box that trusts the issuer.
   */
  verifyClaims(
    token: string,
    options?: { audience?: string[] },
  ): Promise<{ issuer: string; subject: string } | null>;
}
