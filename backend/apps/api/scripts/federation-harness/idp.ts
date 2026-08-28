/**
 * The harness's stand-in for CI-Portal: a loopback OIDC issuer that publishes a
 * JWKS and mints RS256 access tokens.
 *
 * ═══ WHY THIS IS ENOUGH, AND WHY THAT IS THE INTERESTING PART ═══
 *
 * `PortalTokenService` does not know what CI-Portal is. It does exactly two
 * configurable things:
 *
 *   createRemoteJWKSet(new URL(config.auth.portal.jwksUri))
 *   jwtVerify(token, jwks, { issuer: config.auth.portal.issuer, audience })
 *
 * `issuer` and `jwksUri` are ordinary config strings (PORTAL_OIDC_ISSUER /
 * PORTAL_OIDC_JWKS_URI). Anything that publishes a JWKS at that URI and signs
 * with a key in it satisfies the verifier completely. So a full federation demo
 * needs no Portal deployment, no better-auth, no network — 90 lines of node:http
 * and `jose` reproduce the entire trust anchor.
 *
 * That is not a shortcut around a security check; it is the check working as
 * designed. The verifier's job is "prove this token was signed by the key at the
 * issuer I was configured to trust". Pointing it at a different issuer changes
 * WHO it trusts, which is an operator decision, and leaves the proof intact.
 * Nothing here weakens signature, issuer, audience, or expiry validation — every
 * token this file mints is a real RS256 JWT that a real `jwtVerify` accepts or
 * rejects on its merits.
 *
 * ═══ THE ALGORITHM TRAP ═══
 *
 * `PortalTokenService`'s docstring says CI-Portal signs with **EdDSA**, which
 * reads like a constraint on what this issuer may use. It is not: `jose` picks
 * the verification algorithm from the JOSE header and the matching JWK, not from
 * a configured allowlist, so RS256 verifies fine. RS256 is used here because
 * `crypto.createPublicKey().export({ format: 'jwk' })` produces a JWKS entry for
 * it with no extra dependency, and because an RSA key is what every JWKS
 * debugging tool expects to see.
 */
import { createPublicKey, createPrivateKey } from 'node:crypto';
import http from 'node:http';

import { SignJWT, exportJWK, type JWK } from 'jose';

import { loadFixtureKey } from './INSECURE_TEST_KEY';

/** How long a minted token is good for. Short, so an expiry bug shows up here. */
const DEFAULT_TTL_SECONDS = 300;

export interface MintOptions {
  /** OIDC subject — the peer's stable identity. Matched against `peer_links.peer_subject`. */
  subject: string;
  /** The audience the token is ADDRESSED TO — i.e. the receiving box's `peers.audience`. */
  audience: string;
  /** Issuer URL; must equal the receiving box's PORTAL_OIDC_ISSUER exactly. */
  issuer: string;
  ttlSeconds?: number;
  /** Set in the past to mint a deliberately expired token (negative-path tests). */
  issuedAt?: number;
}

/**
 * Mint an RS256 access token.
 *
 * Exported separately from the server on purpose: the scenario driver signs
 * in-process rather than calling a mint endpoint, so there is no unauthenticated
 * "give me a token for any subject" HTTP surface anywhere in this harness. The
 * server below serves the JWKS and nothing else.
 */
export async function mintToken(options: MintOptions): Promise<string> {
  const { privateKeyPem, keyId } = loadFixtureKey();
  const key = createPrivateKey(privateKeyPem);
  const issuedAt = options.issuedAt ?? Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: keyId, typ: 'JWT' })
    .setIssuer(options.issuer)
    .setSubject(options.subject)
    .setAudience(options.audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + (options.ttlSeconds ?? DEFAULT_TTL_SECONDS))
    .sign(key);
}

/** The JWKS document both boxes fetch. */
export async function jwksDocument(): Promise<{ keys: JWK[] }> {
  const { publicKeyPem, keyId } = loadFixtureKey();
  const jwk = await exportJWK(createPublicKey(publicKeyPem));

  return { keys: [{ ...jwk, kid: keyId, use: 'sig', alg: 'RS256' }] };
}

export interface IdpHandle {
  issuer: string;
  jwksUri: string;
  port: number;
  close(): Promise<void>;
}

export const JWKS_PATH = '/.well-known/jwks.json';
const DISCOVERY_PATH = '/.well-known/openid-configuration';

/**
 * Start the issuer on `127.0.0.1:<port>`.
 *
 * Bound to loopback explicitly rather than `0.0.0.0`. A JWKS is public data, so
 * the exposure would be harmless — but the fixture key is not, and a harness
 * that listens on every interface is one `PORTAL_OIDC_JWKS_URI` typo away from a
 * real box trusting it.
 */
export function startIdp(port: number): Promise<IdpHandle> {
  const issuer = `http://127.0.0.1:${port}`;

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', issuer);

      if (url.pathname === JWKS_PATH) {
        const body = JSON.stringify(await jwksDocument());
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(body);

        return;
      }

      if (url.pathname === DISCOVERY_PATH) {
        // Not read by CI-Server (PortalTokenService is pointed straight at the
        // JWKS), but it makes the issuer inspectable with ordinary OIDC tooling
        // when a run misbehaves.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer,
            jwks_uri: `${issuer}${JWKS_PATH}`,
            id_token_signing_alg_values_supported: ['RS256'],
            response_types_supported: ['token'],
            subject_types_supported: ['public'],
          }),
        );

        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    })();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        issuer,
        jwksUri: `${issuer}${JWKS_PATH}`,
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
