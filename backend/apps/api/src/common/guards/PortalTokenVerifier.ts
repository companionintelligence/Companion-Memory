/**
 * DI seam for portal-token validation. Lives in `common` (no domain imports) so
 * JwtOrApiKeyAuthGuard can depend on it without creating a guard → auth → user →
 * guard import cycle. The implementation (PortalTokenService) is provided under
 * this token by PortalAuthModule.
 */
export const PORTAL_TOKEN_VERIFIER = 'PORTAL_TOKEN_VERIFIER';

export interface PortalTokenVerifier {
  /** Whether portal-brokered OIDC auth is enabled. */
  readonly enabled: boolean;
  /**
   * Verify a portal-issued Bearer token and return the matching user (id), or
   * null if it is not a valid portal token.
   */
  verifyAndProvision(token: string): Promise<{ id: string } | null>;
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
