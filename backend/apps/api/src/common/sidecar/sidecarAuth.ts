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

/**
 * The bearer for the document parser alone: its own PARSER_AUTH_SECRET, so the parser never holds
 * the key the summary and HBPE sidecars accept. Falls back to SIDECAR_AUTH_SECRET on an install
 * whose parser still runs inside the summary container and has no key of its own.
 */
export function parserAuthHeaders(): Record<string, string> {
  const secret = config.services.parserAuthSecret || config.services.sidecarAuthSecret;

  return secret ? { Authorization: `Bearer ${secret}` } : {};
}
