import net from 'node:net';

/**
 * Client ID Metadata Document (CIMD) validator for MCP 2026-07-28 OAuth clients.
 *
 * Replaces Dynamic Client Registration (DCR) with URL-based client identifiers (`https://...`)
 * whose host is a public domain (never a raw IP, loopback, or private-range address).
 */

export interface CimdDocument {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
}

const PRIVATE_HOST_SUFFIXES = ['.local', '.internal', '.localhost', '.home.arpa'];

export function isValidCimdClientId(clientId: string): boolean {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return false;
  }

  // Must carry a non-root path to distinguish a metadata document from a bare origin
  if (url.pathname === '' || url.pathname === '/') {
    return false;
  }

  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || PRIVATE_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return false;
  }

  if (net.isIP(host) !== 0) {
    return false;
  }

  return true;
}

export function validateCimdDocument(
  clientId: string,
  doc: unknown,
): { valid: true; document: CimdDocument } | { valid: false; reason: string } {
  if (!isValidCimdClientId(clientId)) {
    return { valid: false, reason: 'client_id is not a valid public HTTPS CIMD URL' };
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { valid: false, reason: 'CIMD payload must be a JSON object' };
  }

  const obj = doc as Record<string, unknown>;
  if (obj.client_id !== clientId) {
    return { valid: false, reason: 'CIMD client_id does not match fetched URL' };
  }

  if (typeof obj.client_name !== 'string' || obj.client_name.trim().length === 0) {
    return { valid: false, reason: 'CIMD client_name must be a non-empty string' };
  }

  if (!Array.isArray(obj.redirect_uris) || obj.redirect_uris.length === 0) {
    return { valid: false, reason: 'CIMD redirect_uris must be a non-empty array' };
  }

  for (const uri of obj.redirect_uris) {
    if (typeof uri !== 'string') {
      return { valid: false, reason: 'CIMD redirect_uris entries must be strings' };
    }

    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && !parsed.protocol.endsWith(':')) {
        return { valid: false, reason: 'Invalid redirect_uri scheme' };
      }
    } catch {
      return { valid: false, reason: `Malformed redirect_uri: ${uri}` };
    }
  }

  return {
    valid: true,
    document: {
      client_id: obj.client_id,
      client_name: obj.client_name.trim(),
      redirect_uris: obj.redirect_uris as string[],
      ...(Array.isArray(obj.grant_types) ? { grant_types: obj.grant_types as string[] } : {}),
      ...(Array.isArray(obj.response_types) ? { response_types: obj.response_types as string[] } : {}),
      ...(typeof obj.token_endpoint_auth_method === 'string'
        ? { token_endpoint_auth_method: obj.token_endpoint_auth_method }
        : {}),
    },
  };
}
