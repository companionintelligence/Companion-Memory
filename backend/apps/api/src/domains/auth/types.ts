export interface LoginDto {
  username: string;
  password: string;
}

export interface SignupDto {
  name: string;
  email: string;
  password: string;
  signup_code?: string;
}

export interface JwtPayload {
  sub: string;
  /**
   * Session id (the SessionEntity row) the token belongs to. Present on
   * session tokens minted since CSRF principal-binding; access tokens and
   * legacy session tokens carry only `sub`. Optional so pre-upgrade cookies
   * keep verifying — a sid-less session token resolves to the anonymous CSRF
   * scope until its first rotation embeds the claim.
   */
  sid?: string;
}

export interface SignedRequest extends Request {
  userId: string;
}

export interface SessionMetadata {
  ip?: string;
  userAgent?: string;
}

export interface UpdateSignupCodeDto {
  used?: boolean;
}

export interface RotationResult {
  /** New session token, or `null` on a grace-period match (keep the cookie). */
  sessionToken: string | null;
  /**
   * Id of the session row the refresh matched — returned on BOTH branches, so
   * the refresh response can bind (or upgrade) the CSRF cookie to its session
   * even when a grace match sets no new session cookie.
   */
  sessionId: string;
}

/**
 * A freshly-issued session: the signed cookie value plus the id of the row it
 * belongs to, so identity-boundary callers (login / signup / OIDC) can mint a
 * CSRF token bound to that very session.
 */
export interface IssuedSession {
  sessionToken: string;
  sessionId: string;
}

/**
 * Who owns an api key's lifecycle. `null` = user-created (theirs to rename and
 * re-scope); `'connect'` = minted by the Companion Memory consent flow, so CI-Hub
 * rotates and revokes it. Recorded explicitly — the `app:` name prefix is
 * user-settable and so is not proof of provenance.
 */
export type ApiKeyProvenance = 'connect';

/**
 * The one `ApiKeyProvenance` value, in one place. Mint (ConnectService), lifecycle
 * lookup (ApiKeyService.findUserIdByName / removeByName / isHubManagedKey) and the
 * UI's managed-key badge must all agree on this literal: if they ever disagreed, the
 * Hub would stamp one value and search for another — silently losing the ability to
 * rotate or revoke the very keys it minted, with no type error to catch it.
 */
export const CONNECT_PROVENANCE: ApiKeyProvenance = 'connect';

/**
 * Name prefix of every connect key (`app:<appName>:<store>`). Reserved from
 * user-created names so the two namespaces stay visually distinct — provenance
 * itself is carried by {@link CONNECT_PROVENANCE}, never by this string.
 */
export const CONNECT_KEY_NAME_PREFIX = 'app:';

export interface CreateApiKeyDto {
  name: string;
  scopes?: string[];
  expires_at?: string;
}

export interface UpdateApiKeyDto {
  name?: string;
  scopes?: string[];
}

export interface ApiKeyResponse {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expires_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateApiKeyResponse extends ApiKeyResponse {
  key: string;
}
