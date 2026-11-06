/**
 * The service description (PWS "Service Description"): the one unauthenticated document that
 * names every specification and version this server speaks, and the server-wide URLs a client
 * needs before it holds a Space. It has no fixed path; every response carries a
 * `Link: <...>; rel="service"` header pointing at it.
 *
 * Only what this implementation really does is advertised. A client that reads a feature token
 * here is entitled to rely on it, and "a host can stop advertising an affordance it once did",
 * so the list below is the contract, not an aspiration. Not advertised, because not built:
 * `backends`, `quotas`, `changes-query`, `export`, `import`, the Encrypted Collections profile.
 */
import type { JsonObject } from './dataIntegrity';
import type { PwsUrls } from './routes';

export const PWS_SPEC_ID = 'https://w3id.org/pws';
export const PWS_AUTHZ_PROFILE_ID = 'https://w3id.org/pws/authz-profile';
export const PWS_SPEC_VERSION = '0.5';
export const PWS_AUTHZ_VERSION = '0.1';

/** Feature tokens for the optional sections of PWS 0.5 that this server implements. */
export const FEATURES = [
  'listing',
  'collection-management',
  'space-management',
  'linksets',
  'policy',
  'metadata',
  'created-by',
] as const;

export interface InstanceDisclosure {
  name?: string;
  /** Prefer a major version only: an exact patch level hands scanners a target list. */
  version?: string;
  source?: string;
  homepage?: string;
}

export function buildServiceDescription(
  urls: PwsUrls,
  instance?: InstanceDisclosure,
  originId?: string,
): JsonObject {
  return {
    url: urls.serviceUrl(),
    specs: {
      [PWS_SPEC_ID]: [
        {
          version: PWS_SPEC_VERSION,
          url: 'https://w3c-ccg.github.io/portable-web-spaces-spec/',
          spaces: urls.spacesUrl(),
          features: [...FEATURES],
          // The store that mints this server's write stamps (an extension; see `stamp.ts`).
          ...(originId !== undefined ? { originId } : {}),
        },
      ],
      [PWS_AUTHZ_PROFILE_ID]: [
        {
          version: PWS_AUTHZ_VERSION,
          url: 'https://w3c-ccg.github.io/portable-web-spaces-spec/authz-profile/',
          signatureAlgorithms: ['EdDSA'],
          zcapCryptosuites: ['eddsa-jcs-2022'],
        },
      ],
    },
    ...(instance && Object.keys(instance).length > 0 ? { instance: { ...instance } } : {}),
  };
}

/** The value of the `Link` header every response carries. */
export function serviceLink(urls: PwsUrls): string {
  return `<${urls.serviceUrl()}>; rel="service"`;
}
