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
  sessionToken: string | null;
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
