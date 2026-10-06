import type { ApiKeyCapability } from '@ci/common/decorators';

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
  capability?: ApiKeyCapability;
  expires_at?: string;
}

export interface UpdateApiKeyDto {
  name?: string;
  scopes?: string[];
  capability?: ApiKeyCapability;
}

export interface ApiKeyResponse {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  capability: ApiKeyCapability;
  expires_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateApiKeyResponse extends ApiKeyResponse {
  key: string;
}

/**
 * What `ApiKeyService.validateKey` hands the auth strategy.
 *
 * `keyId` identifies WHICH key authenticated; `managedBy` and `name` say where it
 * came from. The last two are the difference between "a caller with write
 * authority" and "the OpenClaw harness acting on the owner's behalf" — a
 * distinction the capability axis alone cannot express, because an owner's
 * hand-made key and a connect-minted harness key can hold identical powers.
 */
export interface ValidatedApiKey {
  keyId: string;
  userId: string;
  scopes: string[];
  capability: ApiKeyCapability;
  managedBy: ApiKeyProvenance | null;
  name: string | null;
}

/**
 * Is this caller an installed app acting for the owner, rather than the owner?
 *
 * Reads `managed_by` and NEVER the name prefix: a user can hand-create a key
 * called `app:home-assistant`, and ApiKeyEntity's docblock is explicit that
 * provenance comes from the column. The name is for labelling a card once this
 * has already answered yes.
 *
 * The distinction exists because an owner's trust dial is an OWNER convenience.
 * It should not decide whether a borrowed agent gets confirmed before doing
 * something irreversible, and it must not let that agent answer its own card.
 */
export function isManagedAppPrincipal(key: { managedBy?: ApiKeyProvenance | null }): boolean {
  return key.managedBy === CONNECT_PROVENANCE;
}

/**
 * The installed app a connect key was minted for (`ci-openclaw` for
 * `app:ci-openclaw:ci-marketplace`), or `null` for any key the connect flow did
 * not mint. Provenance decides first, as in {@link isManagedAppPrincipal}; the
 * name is read only once `managed_by` has vouched for it, so a hand-made key
 * named `app:ci-openclaw:x` names no app.
 */
export function connectAppNameOf(key: {
  managedBy?: ApiKeyProvenance | null;
  name?: string | null;
}): string | null {
  if (!isManagedAppPrincipal(key) || !key.name?.startsWith(CONNECT_KEY_NAME_PREFIX)) {
    return null;
  }

  const appName = key.name.slice(CONNECT_KEY_NAME_PREFIX.length).split(':')[0];

  return appName ? appName : null;
}
