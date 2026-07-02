import type { JWTPayload } from 'jose';

/**
 * Portal-brokered service-credential resolution.
 *
 * Replaces the legacy Server↔HBPE trust model, where sidecars (HBPE, Summary)
 * self-signed HS256 JWTs with the shared `AUTH_JWT_AUTHTOKENSECRET` and the
 * Server's `JwtStrategy` accepted anything signed with that symmetric secret.
 * A leaked secret meant full user impersonation for every service.
 *
 * The Portal-brokered model (unified-identity-plan.md · Track B / B5, Track D /
 * D3) instead has each sidecar present a CI-Portal-issued, asymmetrically-signed
 * (EdDSA) service token. The Server already verifies these against the Portal
 * JWKS it holds — see `PortalTokenService`. This module adds the missing piece:
 * recognising a *service account* principal (a machine, e.g. `hbpe-sidecar`)
 * distinctly from a human OIDC login, so we resolve the on-behalf-of user by a
 * stable id rather than JIT-provisioning a phantom user keyed on an email claim.
 *
 * Token shape (RFC 8693 token-exchange result, or the interim Portal-signed
 * service JWT until D3 lands):
 *
 *   {
 *     "iss": "<portal issuer>",
 *     "aud": "ci-server",
 *     "sub": "<CI-Server user id the service acts on behalf of>",
 *     "client_id": "hbpe-sidecar",         // or "azp"
 *     "scope": "memory:read memory:write", // space-delimited, optional here
 *     "act": { "sub": "hbpe-sidecar" }     // RFC 8693 actor claim, optional
 *   }
 *
 * The signature (EdDSA, Portal JWKS), issuer and audience are verified by
 * `PortalTokenService` *before* this helper runs; this module only interprets
 * the already-trusted claim set.
 */

/** Claims relevant to identifying a service-account principal. */
export interface ServiceAccountClaims {
  /** OAuth client id of the presenting client. */
  client_id?: unknown;
  /** Authorized party — better-auth / OIDC alternative to `client_id`. */
  azp?: unknown;
  /** RFC 8693 actor claim; `act.sub` names the acting service. */
  act?: unknown;
  /** Space-delimited OAuth scopes. */
  scope?: unknown;
}

/** The verified identity of a service-account request. */
export interface ResolvedServiceAccount {
  /** The allow-listed client id of the acting service (e.g. `hbpe-sidecar`). */
  clientId: string;
  /** The CI-Server user id the service is acting on behalf of (token `sub`). */
  onBehalfOfUserId: string;
  /** Granted scopes parsed from the `scope` claim (empty when absent). */
  scopes: string[];
}

/**
 * Read the client id a token presents, preferring the RFC 8693 `act.sub` actor
 * claim (set by token exchange), then `client_id`, then `azp`. Returns null when
 * none is a non-empty string.
 */
export function extractServiceClientId(payload: ServiceAccountClaims): string | null {
  const act = payload.act;
  if (act && typeof act === 'object' && 'sub' in act) {
    const actorSub = (act as { sub?: unknown }).sub;
    if (typeof actorSub === 'string' && actorSub.trim()) {
      return actorSub.trim();
    }
  }

  for (const candidate of [payload.client_id, payload.azp]) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

/** Parse a space-delimited OAuth `scope` claim into a de-duplicated list. */
export function parseScopes(scope: unknown): string[] {
  if (typeof scope !== 'string') {
    return [];
  }

  return Array.from(new Set(scope.split(/\s+/).filter(Boolean)));
}

/**
 * Resolve an already-signature-verified Portal token to a service-account
 * principal, or null when it is not one (so the caller treats it as an ordinary
 * human OIDC login).
 *
 * A token is a service-account credential iff it presents a client id that is in
 * the configured allow-list. When it is, `sub` MUST name the CI-Server user the
 * service acts on behalf of — a service token with no `sub` is rejected (null),
 * because a service must never gain an ambient, user-less identity.
 *
 * @param payload      the verified JWT claim set
 * @param allowedClients allow-listed service client ids (e.g. `["hbpe-sidecar"]`)
 */
export function resolveServiceAccount(
  payload: JWTPayload & ServiceAccountClaims,
  allowedClients: readonly string[],
): ResolvedServiceAccount | null {
  if (allowedClients.length === 0) {
    return null;
  }

  const clientId = extractServiceClientId(payload);
  if (!clientId || !allowedClients.includes(clientId)) {
    return null;
  }

  const onBehalfOfUserId = payload.sub;
  if (typeof onBehalfOfUserId !== 'string' || !onBehalfOfUserId.trim()) {
    return null;
  }

  return {
    clientId,
    onBehalfOfUserId: onBehalfOfUserId.trim(),
    scopes: parseScopes(payload.scope),
  };
}

/** Parse a comma-separated allow-list config value into trimmed client ids. */
export function parseAllowedServiceClients(raw: string | undefined | null): string[] {
  if (!raw) {
    return [];
  }

  return Array.from(
    new Set(
      raw
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean),
    ),
  );
}
