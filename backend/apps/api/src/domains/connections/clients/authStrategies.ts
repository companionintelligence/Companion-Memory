import { createHmac, randomBytes } from 'node:crypto';

/**
 * Auth strategies sign an outbound request descriptor with credentials taken
 * from a connection record (`ConnectionEntity` tokens plus the provider's
 * `ProviderKeyEntity` consumer key/secret) — never from user input.
 *
 * Each strategy returns a `RequestSignature` — a partial set of headers and/or
 * query parameters to merge into the outbound request. Strategies perform no
 * I/O and no storage; token exchange and refresh stay in the client classes
 * (`BaseOAuth2Client` and friends). OAuth1 signatures cover the request
 * method, URL, and parameters, so `sign()` receives the fully-resolved
 * `SigningRequest`.
 *
 * `schema` carries the provider-level auth configuration (`auth_key` /
 * `auth_secret` for OAuth1, `signature` mode for OAuth2); `credentials`
 * carries the per-connection secrets.
 */

export interface SigningRequest {
  method: string;
  /** Absolute request URL without the query string. */
  url: string;
  /** Query parameters that will be sent with the request. */
  parameters: Record<string, string | number | boolean | Array<string | number | boolean>>;
}

export interface RequestSignature {
  headers?: Record<string, string>;
  parameters?: Record<string, string>;
  /** Opaque principal identity, suitable for {@link Requester}'s dedup cache key. */
  identity?: string | null;
}

export interface AuthStrategy {
  readonly type: string;
  sign(
    schema: Record<string, unknown>,
    credentials: Record<string, unknown> | undefined,
    request: SigningRequest,
  ): RequestSignature;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

class HttpBasicStrategy implements AuthStrategy {
  readonly type = 'basic';

  sign(_schema: Record<string, unknown>, credentials: Record<string, unknown> = {}): RequestSignature {
    const user = credentials.username ?? credentials.user ?? '';
    const pass = credentials.password ?? credentials.pass ?? '';
    const token = Buffer.from(`${String(user)}:${String(pass)}`).toString('base64');

    return {
      headers: { Authorization: `Basic ${token}` },
      identity: `basic:${String(user)}`,
    };
  }
}

class OAuth2Strategy implements AuthStrategy {
  readonly type = 'oauth2';

  sign(schema: Record<string, unknown>, credentials: Record<string, unknown> = {}): RequestSignature {
    const accessToken = String(credentials.access_token ?? credentials.accessToken ?? '');

    if (accessToken === '') {
      throw new AuthError('OAuth2 requires an access_token in the connection credentials');
    }

    const signatureMode = String(schema.signature ?? 'parameter');
    const identity = `oauth2:${accessToken.slice(0, 16)}`;

    if (signatureMode === 'header' || schema.use_auth_header === true) {
      return {
        headers: { Authorization: `Bearer ${accessToken}` },
        identity,
      };
    }

    return {
      parameters: { access_token: accessToken },
      identity,
    };
  }
}

/**
 * OAuth 1.0a HMAC-SHA1 signing per RFC 5849 §3.4. The consumer key/secret come
 * from the provider auth schema (`auth_key`/`auth_secret`); the token
 * credentials come from the connection. The signature covers the method, the base URI, the
 * query parameters, and the generated `oauth_*` protocol parameters, and is
 * emitted as an `Authorization: OAuth …` header.
 *
 * Bodies are sent as JSON, never `application/x-www-form-urlencoded`, so body
 * parameters are correctly excluded from the signature base string.
 */
class OAuth1Strategy implements AuthStrategy {
  readonly type = 'oauth1';

  sign(
    schema: Record<string, unknown>,
    credentials: Record<string, unknown> = {},
    request: SigningRequest,
  ): RequestSignature {
    const consumerKey = String(schema.auth_key ?? credentials.consumer_key ?? '');
    const consumerSecret = String(schema.auth_secret ?? credentials.consumer_secret ?? '');

    if (consumerKey === '' || consumerSecret === '') {
      throw new AuthError('OAuth1 requires auth_key/auth_secret in the provider auth schema');
    }

    const token = credentials.oauth_token ?? credentials.access_token ?? null;
    const tokenSecret = String(
      credentials.oauth_token_secret ?? credentials.access_token_secret ?? credentials.token_secret ?? '',
    );

    // Overridable for deterministic tests; generated otherwise.
    const nonce = String(credentials.oauth_nonce ?? randomBytes(16).toString('hex'));
    const timestamp = String(credentials.oauth_timestamp ?? Math.floor(Date.now() / 1000));

    const oauthParameters: Record<string, string> = {
      oauth_consumer_key: consumerKey,
      oauth_nonce: nonce,
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: timestamp,
      oauth_version: '1.0',
    };

    if (token != null && token !== '') {
      oauthParameters.oauth_token = String(token);
    }

    const baseString = signatureBaseString(request, oauthParameters);
    const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
    const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');

    const headerParameters: Record<string, string> = { ...oauthParameters, oauth_signature: signature };
    const header = Object.keys(headerParameters)
      .sort()
      .map((name) => `${percentEncode(name)}="${percentEncode(headerParameters[name])}"`)
      .join(', ');

    return {
      headers: { Authorization: `OAuth ${header}` },
      identity: `oauth1:${token != null ? String(token) : consumerKey}`,
    };
  }
}

class OpenIDStrategy implements AuthStrategy {
  readonly type = 'openid';

  sign(_schema: Record<string, unknown>, credentials: Record<string, unknown> = {}): RequestSignature {
    const key = credentials.key ?? credentials.auth_key;

    if (key == null) {
      throw new AuthError('OpenID strategy requires `key` in the connection credentials');
    }

    return {
      parameters: { key: String(key) },
      identity: `openid:${String(key)}`,
    };
  }
}

/** RFC 3986 §2.1 percent-encoding — stricter than encodeURIComponent. */
function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** RFC 5849 §3.4.1.2 — scheme/host lowercased, default ports dropped, no query. */
function baseStringUri(rawUrl: string): string {
  const url = new URL(rawUrl);
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  const host = url.hostname.toLowerCase();
  const port = url.port;
  const isDefaultPort = (scheme === 'http' && port === '80') || (scheme === 'https' && port === '443');
  const authority = port !== '' && !isDefaultPort ? `${host}:${port}` : host;

  return `${scheme}://${authority}${url.pathname}`;
}

/** RFC 5849 §3.4.1.3.2 — encode pairs, sort by name then value, join with &. */
function signatureBaseString(request: SigningRequest, oauthParameters: Record<string, string>): string {
  const pairs: Array<[string, string]> = [];

  for (const [name, value] of Object.entries(request.parameters)) {
    const items = Array.isArray(value) ? value : [value];

    for (const item of items) {
      pairs.push([percentEncode(name), percentEncode(String(item))]);
    }
  }

  for (const [name, value] of Object.entries(oauthParameters)) {
    pairs.push([percentEncode(name), percentEncode(value)]);
  }

  pairs.sort(([aKey, aValue], [bKey, bValue]) =>
    aKey === bKey ? (aValue < bValue ? -1 : 1) : aKey < bKey ? -1 : 1,
  );

  const normalized = pairs.map(([name, value]) => `${name}=${value}`).join('&');

  return [
    request.method.toUpperCase(),
    percentEncode(baseStringUri(request.url)),
    percentEncode(normalized),
  ].join('&');
}

const STRATEGIES: Record<string, AuthStrategy> = {
  basic: new HttpBasicStrategy(),
  http_basic: new HttpBasicStrategy(),
  oauth2: new OAuth2Strategy(),
  oauth1: new OAuth1Strategy(),
  openid: new OpenIDStrategy(),
};

export function resolveAuthStrategy(type: string | undefined): AuthStrategy | null {
  if (type == null) {
    return null;
  }

  const key = String(type).toLowerCase();

  return STRATEGIES[key] ?? null;
}
