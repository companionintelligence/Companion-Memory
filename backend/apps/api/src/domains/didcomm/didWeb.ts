import { type DidDocument, type DidResolver, parseDidDocument } from './didDocument';
import { DidcommError } from './errors';

/**
 * `did:web` (https://w3c-ccg.github.io/did-method-web/): the DID is a host and an optional path,
 * and the document is the JSON file at a well-known URL.
 *
 *     did:web:example.com                   → https://example.com/.well-known/did.json
 *     did:web:example.com:users:alice       → https://example.com/users/alice/did.json
 *     did:web:example.com%3A8443:users      → https://example.com:8443/users/did.json
 *
 * This module builds the URL and checks the answer; it does not make the request. The caller
 * passes `fetchJson`, because fetching a URL derived from a stranger's DID is the textbook
 * server-side request forgery vector and the policy for it (no redirects, no private addresses,
 * connect-time DNS pinning, size and time limits) already exists in Companion Memory's peer egress
 * (`peerEgressFetch`) and must not be re-implemented here. The URL this module hands over is always
 * `https:`, never has credentials, and never has a path segment that could climb out of its place.
 *
 * `did:web` anchors trust in DNS and the web PKI. The KERI page in these docs makes the same point
 * as a reason to prefer self-certifying identifiers for pairwise relationships; `did:web` fits
 * organisations that already publish a domain, not people.
 */

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const SEGMENT = /^[A-Za-z0-9._~-]+$/;

function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new DidcommError('did-resolution-failed', 'did:web contains invalid percent-encoding');
  }
}

/** The `https:` URL of the document for a `did:web`, or `did-resolution-failed` for anything unsafe. */
export function didWebToUrl(did: string): string {
  if (typeof did !== 'string' || !did.startsWith('did:web:') || /[/?#\s]/.test(did)) {
    throw new DidcommError('unsupported-did-method', 'not a did:web identifier');
  }

  const [hostPart, ...pathParts] = did.slice('did:web:'.length).split(':');
  const decodedHost = decodeOnce(hostPart).toLowerCase();
  const [host, port, extra] = decodedHost.split(':');

  if (extra !== undefined) {
    throw new DidcommError('did-resolution-failed', 'did:web host has more than one port');
  }

  const labels = host.split('.');
  const topLevel = labels[labels.length - 1];

  if (
    labels.length < 2 ||
    !labels.every((label) => label.length <= 63 && LABEL.test(label)) ||
    // A numeric top-level label is an IPv4 address, not a name. did:web names an organisation's
    // domain; reaching an address literal is what a request-forgery payload looks like.
    /^[0-9]+$/.test(topLevel)
  ) {
    throw new DidcommError('did-resolution-failed', 'did:web host must be a domain name');
  }

  if (port !== undefined && !(/^[0-9]{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) {
    throw new DidcommError('did-resolution-failed', 'did:web port is not valid');
  }

  const authority = port === undefined ? host : `${host}:${port}`;

  if (pathParts.length === 0) {
    return `https://${authority}/.well-known/did.json`;
  }

  const segments = pathParts.map(decodeOnce);

  if (
    segments.some(
      (segment) => !SEGMENT.test(segment) || segment === '.' || segment === '..' || /^\.+$/.test(segment),
    )
  ) {
    throw new DidcommError('did-resolution-failed', 'did:web path segment is not valid');
  }

  return `https://${authority}/${segments.join('/')}/did.json`;
}

export interface DidWebOptions {
  /**
   * Fetches `url` and returns the parsed JSON body. Must enforce the deployment's egress policy,
   * and must reject on any non-2xx answer.
   */
  fetchJson(url: string): Promise<unknown>;
}

export function createDidWebResolver(options: DidWebOptions): DidResolver {
  return {
    async resolve(did: string): Promise<DidDocument> {
      const url = didWebToUrl(did);
      let body: unknown;

      try {
        body = await options.fetchJson(url);
      } catch {
        throw new DidcommError('did-resolution-failed', `could not fetch the did:web document for ${did}`);
      }

      // The document must claim to be this DID: a host can answer with anyone's document.
      return parseDidDocument(body, did);
    },
  };
}
