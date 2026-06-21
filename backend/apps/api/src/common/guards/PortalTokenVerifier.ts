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
}
