import { ContextService } from '@ci/common/context';

import { extractBearerToken } from './bearerToken';
import type { GuardedRequest } from './guardRequest';
import type { PortalPrincipal, PortalTokenVerifier } from './PortalTokenVerifier';

/**
 * The Portal-brokered OIDC path the session guards try first, before their
 * passport strategies (gated by `auth.portal.enabled`). `null` whenever that
 * path has nothing to say — Portal acceptance off, no bearer on the request,
 * or a token the verifier did not recognise — and the guard falls through to
 * its strategies. A refusal the verifier throws passes through as it is.
 *
 * What to do with a principal is the guard's own policy: one confines a
 * limited principal like an api key, another refuses it outright.
 */
export async function acceptPortalBearer(
  verifier: PortalTokenVerifier,
  request: GuardedRequest,
): Promise<PortalPrincipal | null> {
  if (!verifier.enabled) {
    return null;
  }

  const token = extractBearerToken(request?.headers?.authorization);

  return token ? verifier.verifyAndProvision(token) : null;
}

/**
 * Make the Portal principal the request's user: the request context, the
 * `user` the handlers read, and the marker the admin guards read.
 */
export function bindPortalPrincipal(request: GuardedRequest, principal: PortalPrincipal): void {
  ContextService.set({ userId: principal.user.id });
  request.user = principal.user;
  request.portalPrincipal = { admin: principal.admin };
}
