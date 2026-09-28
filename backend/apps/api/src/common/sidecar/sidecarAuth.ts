import config from '@ci/configuration';

/**
 * The bearer every request to a Python sidecar (HBPE, Summary, the document
 * parser) must carry. One shared secret, minted by setup-secrets, presented by
 * the API and required by the sidecars' middleware: it makes "can open a TCP
 * connection to the sidecar" stop meaning "can run any function for any user".
 *
 * Empty in a misconfigured dev environment (the API warns at boot; production
 * refuses to boot), in which case no header is sent and the sidecar answers 401
 * or 503 — visibly, rather than the request quietly succeeding.
 */
export function sidecarAuthHeaders(): Record<string, string> {
  const secret = config.services.sidecarAuthSecret;

  return secret ? { Authorization: `Bearer ${secret}` } : {};
}
