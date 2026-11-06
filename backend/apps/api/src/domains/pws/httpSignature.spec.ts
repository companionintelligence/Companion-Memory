import { PWS_AUTHZ_WORKED_EXAMPLE } from './__tests__/referenceVectors';
import { publicKeyFromDidKey } from './didKey';
import { digestHeaderValue, verifyDigestHeader } from './digest';
import { LocalEd25519Signer, verifyEd25519 } from './ed25519';
import {
  buildSigningString,
  checkSignatureWindow,
  HttpSignatureError,
  parseAuthorizationSignature,
  signRequest,
} from './httpSignature';
import { base64Encode } from './multibase';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const SIG = base64Encode(new Uint8Array(64).fill(7));
const header = (extra: string, signature = SIG): string =>
  `Signature keyId="did:example:1#k",headers="(created) host",signature="${signature}"${extra}`;

const expectSyntax = (value: string): void => {
  try {
    parseAuthorizationSignature(value);
  } catch (error) {
    expect(error).toBeInstanceOf(HttpSignatureError);
    expect((error as HttpSignatureError).kind).toBe('syntax');

    return;
  }
  throw new Error(`expected a syntax error for: ${value}`);
};

/**
 * The worked example printed in PWS-AUTHZ (copied into `__tests__/referenceVectors.ts`). Its `signature` is NOT a
 * valid Ed25519 signature by the key it names, over any reading of the printed request: 1,727 combinations of the
 * printed lines (with and without `(key-id)`, either method case, with and without the fragment, and every subset of
 * the eight covered lines) were tried against the public key inside the `did:key` on 2026-11-05 and none verifies.
 * The example is illustrative. What it does pin is the grammar and the line layout, which is what these tests
 * check; real signatures are covered by the `signRequest` tests below and by the reference-stack vectors.
 */
describe('the PWS-AUTHZ worked example (illustrative signature, authoritative layout)', () => {
  const example = PWS_AUTHZ_WORKED_EXAMPLE;
  const parsed = parseAuthorizationSignature(
    `Signature keyId="${example.authorization.keyId}",headers="${example.authorization.headers}",` +
      `signature="${example.authorization.signature}",created="${example.authorization.created}",` +
      `expires="${example.authorization.expires}"`,
  );

  it('parses to the covered headers the profile requires for a request with a body', () => {
    expect(parsed.headers).toEqual([
      '(key-id)',
      '(created)',
      '(expires)',
      '(request-target)',
      'host',
      'capability-invocation',
      'content-type',
      'digest',
    ]);
    expect(parsed.created).toBe(1758150502);
    expect(parsed.expires).toBe(1758151102);
    expect(parsed.signature).toHaveLength(64);
  });

  it('lays the signing string out one line per covered header, pseudo-headers first, as the printed headers list says', () => {
    const signingString = buildSigningString({
      headers: parsed.headers,
      keyId: parsed.keyId,
      created: parsed.created,
      expires: parsed.expires,
      method: example.method,
      url: example.url,
      requestHeaders: example.headers,
    });

    expect(signingString.split('\n')).toEqual([
      `(key-id): ${example.authorization.keyId}`,
      '(created): 1758150502',
      '(expires): 1758151102',
      '(request-target): put /space/81246131-69a4-45ab-9bff-9c946b59cf2e/photos/sunset.png',
      'host: example.com',
      `capability-invocation: ${example.headers['capability-invocation']}`,
      'content-type: image/png',
      'digest: mh=uEiCPO-qYr-z0GYV5F75-N1l8Rhjv4xIkKZsnbTZeZ7emSA',
    ]);
    expect(publicKeyFromDidKey(parsed.keyId.split('#')[0] ?? '')).toHaveLength(32);
  });
});

describe('parseAuthorizationSignature', () => {
  it('reads the parameters in the order the reference implementations write them', () => {
    const parsed = parseAuthorizationSignature(header(',created="100",expires="700"'));

    expect(parsed).toEqual({
      keyId: 'did:example:1#k',
      headers: ['(created)', 'host'],
      signature: new Uint8Array(64).fill(7),
      created: 100,
      expires: 700,
    });
  });

  it('accepts created and expires as bare integers, as draft-12 writes them, and ignores spaces after commas', () => {
    const parsed = parseAuthorizationSignature(header(', created=100, expires=700'));

    expect(parsed.created).toBe(100);
    expect(parsed.expires).toBe(700);
  });

  it('defaults to covering (created) when no headers parameter is given, and lowercases header names', () => {
    expect(parseAuthorizationSignature(`Signature keyId="k",signature="${SIG}"`).headers).toEqual([
      '(created)',
    ]);
    expect(
      parseAuthorizationSignature(`Signature keyId="k",headers="Host Content-Type",signature="${SIG}"`)
        .headers,
    ).toEqual(['host', 'content-type']);
  });

  it('keeps the algorithm, lowercased, and ignores parameters it does not know', () => {
    const parsed = parseAuthorizationSignature(header(',algorithm="HS2019",extra="x"'));

    expect(parsed.algorithm).toBe('hs2019');
    expect(parsed).not.toHaveProperty('extra');
  });

  it('takes the scheme case-insensitively', () => {
    expect(parseAuthorizationSignature(header('').replace('Signature', 'signature')).keyId).toBe(
      'did:example:1#k',
    );
  });

  it('refuses a wrong scheme, a missing keyId or signature, and a duplicated parameter', () => {
    expectSyntax(header('').replace('Signature', 'Bearer'));
    expectSyntax(`Signature headers="(created)",signature="${SIG}"`);
    expectSyntax(`Signature keyId="k",headers="(created)"`);
    expectSyntax(`Signature keyId="",signature="${SIG}"`);
    expectSyntax(header(',keyId="other"'));
    expectSyntax(header(',created="1",created="2"'));
    expectSyntax('Signature');
    expectSyntax('');
  });

  it('refuses a signature that is not strict padded base64', () => {
    for (const bad of ['!!!', SIG.slice(0, -1), SIG.replace(/=+$/, ''), `${SIG}\n`, SIG.replace('B', '-')]) {
      expectSyntax(header('', bad));
    }
  });

  it('refuses malformed parameter syntax', () => {
    expectSyntax(`Signature keyId="k,signature="${SIG}"`);
    expectSyntax(`Signature keyId=k,signature="${SIG}"`);
    expectSyntax(`Signature keyId="k" signature="${SIG}"`);
    expectSyntax(`${header('')},`);
    expectSyntax(`${header('')} ,`);
    expectSyntax(header(',created=abc'));
    expectSyntax(header(',created=""'));
    expectSyntax(header(',created="1.5"'));
    expectSyntax(header(',created="-1"'));
    expectSyntax(header(`,created="${'9'.repeat(16)}"`));
    expectSyntax(header(',expires=1.5'));
    expectSyntax(header(',nonsense'));
    expectSyntax(header(',9x="y"'));
    expectSyntax(`Signature keyId="a\\"b",signature="${SIG}"`);
  });

  it('refuses an empty headers list, a repeated name and a name that cannot be a header', () => {
    expectSyntax(`Signature keyId="k",headers="",signature="${SIG}"`);
    expectSyntax(`Signature keyId="k",headers="host host",signature="${SIG}"`);
    expectSyntax(`Signature keyId="k",headers="host  date",signature="${SIG}"`);
    expectSyntax(`Signature keyId="k",headers="(algorithm)",signature="${SIG}"`);
    expectSyntax(`Signature keyId="k",headers="(nope)",signature="${SIG}"`);
    expectSyntax(`Signature keyId="k",headers="ho:st",signature="${SIG}"`);
    expectSyntax(`Signature keyId="k",headers="host(created)",signature="${SIG}"`);
  });
});

describe('buildSigningString', () => {
  const base = {
    keyId: 'did:example:1#k',
    created: 100,
    expires: 700,
    method: 'GET',
    url: 'https://example.com/space/s/c/?limit=2',
    requestHeaders: { 'capability-invocation': 'zcap id="urn:zcap:root:x",action="GET"' },
  };

  it('writes one name: value line per covered header, in order, with the pseudo-headers as specified', () => {
    expect(
      buildSigningString({
        ...base,
        headers: ['(key-id)', '(created)', '(expires)', '(request-target)', 'host', 'capability-invocation'],
      }),
    ).toBe(
      [
        '(key-id): did:example:1#k',
        '(created): 100',
        '(expires): 700',
        '(request-target): get /space/s/c/?limit=2',
        'host: example.com',
        'capability-invocation: zcap id="urn:zcap:root:x",action="GET"',
      ].join('\n'),
    );
  });

  it('takes host from the URL, with the port when it is not the default, and path and query from the URL', () => {
    expect(
      buildSigningString({
        ...base,
        url: 'http://localhost:3002/spaces/',
        headers: ['host', '(request-target)'],
      }),
    ).toBe('host: localhost:3002\n(request-target): get /spaces/');
    expect(
      buildSigningString({
        ...base,
        url: 'https://EXAMPLE.com:443/a/./b/../c?x=1&y=2',
        headers: ['host', '(request-target)'],
      }),
    ).toBe('host: example.com\n(request-target): get /a/c?x=1&y=2');
  });

  it('lowercases the method for (request-target) whatever case the caller used', () => {
    expect(buildSigningString({ ...base, method: 'PuT', headers: ['(request-target)'] })).toBe(
      '(request-target): put /space/s/c/?limit=2',
    );
  });

  it('trims header values, as draft-12 §2.3 asks', () => {
    expect(
      buildSigningString({ ...base, headers: ['digest'], requestHeaders: { digest: '  mh=uEiC  ' } }),
    ).toBe('digest: mh=uEiC');
  });

  it('refuses a covered header the request does not have, a missing parameter and an unknown pseudo-header', () => {
    const syntaxFailure = (args: Parameters<typeof buildSigningString>[0]): void => {
      expect(() => buildSigningString(args)).toThrow(HttpSignatureError);
    };

    syntaxFailure({ ...base, headers: ['content-type'] });
    syntaxFailure({ ...base, headers: ['(created)'], created: undefined });
    syntaxFailure({ ...base, headers: ['(expires)'], expires: undefined });
    syntaxFailure({ ...base, headers: ['(algorithm)'] });
  });

  it('refuses a header value that could forge a second line', () => {
    expect(() =>
      buildSigningString({
        ...base,
        headers: ['digest'],
        requestHeaders: { digest: 'a\nhost: evil.example' },
      }),
    ).toThrow(HttpSignatureError);
    expect(() =>
      buildSigningString({ ...base, headers: ['digest'], requestHeaders: { digest: 'a\rb' } }),
    ).toThrow(HttpSignatureError);
  });

  it('refuses a URL that is not absolute http or https', () => {
    for (const url of ['/space/s/', 'space/s/', 'ftp://example.com/', 'did:key:z6Mk', '']) {
      expect(() => buildSigningString({ ...base, url, headers: ['host'] })).toThrow(HttpSignatureError);
    }
  });
});

describe('checkSignatureWindow', () => {
  const now = 1_000_000;

  it('accepts a signature inside its window, with the skew on both ends', () => {
    expect(() => checkSignatureWindow({ created: now - 5, expires: now + 595 }, now, 300)).not.toThrow();
    expect(() => checkSignatureWindow({ created: now + 300, expires: now + 900 }, now, 300)).not.toThrow();
    expect(() => checkSignatureWindow({ created: now - 900, expires: now - 300 }, now, 300)).not.toThrow();
    expect(() => checkSignatureWindow({}, now, 300)).not.toThrow();
  });

  it('refuses a signature created in the future beyond the skew', () => {
    expect(() => checkSignatureWindow({ created: now + 301 }, now, 300)).toThrow(HttpSignatureError);
  });

  it('refuses an expired signature beyond the skew, with the kind a caller can tell apart from a syntax error', () => {
    try {
      checkSignatureWindow({ created: now - 2000, expires: now - 301 }, now, 300);
    } catch (error) {
      expect((error as HttpSignatureError).kind).toBe('constraint');

      return;
    }
    throw new Error('expected a constraint error');
  });

  it('refuses a signature that expires before it was created', () => {
    expect(() => checkSignatureWindow({ created: now - 10, expires: now - 20 }, now, 300)).toThrow(
      HttpSignatureError,
    );
  });
});

describe('signRequest', () => {
  const signer = new LocalEd25519Signer(
    'did:key:z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2#z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2',
    new Uint8Array(32).fill(9),
  );
  const url = 'https://example.com/space/81246131-69a4-45ab-9bff-9c946b59cf2e/messages/hello-world';
  const capabilityInvocation = `zcap id="urn:zcap:root:${encodeURIComponent(url)}",action="PUT"`;
  const body = text('{"message":"hi"}');

  it('covers exactly the profile’s headers for a bodyless request and signs a string that verifies', async () => {
    const headers = await signRequest({
      method: 'GET',
      url,
      headers: { Accept: 'application/json' },
      signer,
      created: 1_793_880_000,
      capabilityInvocation: capabilityInvocation.replace('PUT', 'GET'),
    });
    const parsed = parseAuthorizationSignature(headers['authorization'] ?? '');

    expect(Object.keys(headers).sort()).toEqual(['accept', 'authorization', 'capability-invocation', 'host']);
    expect(headers['host']).toBe('example.com');
    expect(parsed.headers).toEqual([
      '(key-id)',
      '(created)',
      '(expires)',
      '(request-target)',
      'host',
      'capability-invocation',
    ]);
    expect(parsed.keyId).toBe(signer.id);
    expect(parsed.created).toBe(1_793_880_000);
    expect(parsed.expires).toBe(1_793_880_600);

    const signingString = buildSigningString({
      headers: parsed.headers,
      keyId: parsed.keyId,
      created: parsed.created,
      expires: parsed.expires,
      method: 'GET',
      url,
      requestHeaders: headers,
    });
    expect(verifyEd25519(signer.publicKey, text(signingString), parsed.signature)).toBe(true);
  });

  it('adds content-type and digest to the covered headers when there is a body, and the digest matches the body', async () => {
    const headers = await signRequest({
      method: 'PUT',
      url,
      headers: { 'Content-Type': 'application/json' },
      body,
      signer,
      created: 1_793_880_001,
      expires: 1_793_880_301,
      capabilityInvocation,
    });
    const parsed = parseAuthorizationSignature(headers['authorization'] ?? '');

    expect(parsed.headers.slice(-2)).toEqual(['content-type', 'digest']);
    expect(parsed.expires).toBe(1_793_880_301);
    expect(headers['digest']).toBe(digestHeaderValue(body));
    expect(verifyDigestHeader(headers['digest'] ?? '', body)).toBe(true);
    expect(headers['content-type']).toBe('application/json');
    expect(headers['authorization']).toMatch(
      /^Signature keyId="did:key:[^"]+",headers="\(key-id\) \(created\) \(expires\) \(request-target\) host capability-invocation content-type digest",signature="[A-Za-z0-9+/]{86}==",created="1793880001",expires="1793880301"$/,
    );
  });

  it('produces a signature that stops verifying when any covered element is changed', async () => {
    const sent = await signRequest({
      method: 'PUT',
      url,
      headers: { 'content-type': 'application/json' },
      body,
      signer,
      created: 1_793_880_002,
      capabilityInvocation,
    });
    const parsed = parseAuthorizationSignature(sent['authorization'] ?? '');
    const signingStringFor = (overrides: Partial<Parameters<typeof buildSigningString>[0]>): string =>
      buildSigningString({
        headers: parsed.headers,
        keyId: parsed.keyId,
        created: parsed.created,
        expires: parsed.expires,
        method: 'PUT',
        url,
        requestHeaders: sent,
        ...overrides,
      });
    const verifies = (signingString: string): boolean =>
      verifyEd25519(signer.publicKey, text(signingString), parsed.signature);

    expect(verifies(signingStringFor({}))).toBe(true);
    for (const changed of [
      signingStringFor({ method: 'POST' }),
      signingStringFor({ url: `${url}?x=1` }),
      signingStringFor({ url: url.replace('hello-world', 'hello-there') }),
      signingStringFor({ url: url.replace('example.com', 'example.org') }),
      signingStringFor({ keyId: `${signer.id}x` }),
      signingStringFor({ created: 1_793_880_003 }),
      signingStringFor({ expires: (parsed.expires ?? 0) + 1 }),
      signingStringFor({ requestHeaders: { ...sent, digest: digestHeaderValue(text('{"message":"ho"}')) } }),
      signingStringFor({ requestHeaders: { ...sent, 'content-type': 'text/plain' } }),
      signingStringFor({
        requestHeaders: { ...sent, 'capability-invocation': capabilityInvocation.replace('PUT', 'DELETE') },
      }),
    ]) {
      expect(verifies(changed)).toBe(false);
    }
  });

  it('is deterministic: the same inputs give byte-identical headers', async () => {
    const args = {
      method: 'PUT',
      url,
      headers: { 'content-type': 'text/plain' },
      body,
      signer,
      created: 5,
      capabilityInvocation,
    };

    expect(await signRequest(args)).toEqual(await signRequest(args));
  });

  it('refuses a body without a content-type, a content-type without a body and header injection', async () => {
    const common = { method: 'PUT', url, signer, created: 5, capabilityInvocation };

    await expect(signRequest({ ...common, headers: {}, body })).rejects.toThrow(TypeError);
    await expect(signRequest({ ...common, headers: { 'content-type': 'text/plain' } })).rejects.toThrow(
      TypeError,
    );
    await expect(
      signRequest({ ...common, headers: {}, capabilityInvocation: 'zcap id="a"\r\nx: y' }),
    ).rejects.toThrow(TypeError);
    await expect(
      signRequest({
        ...common,
        headers: {},
        signer: new LocalEd25519Signer('did:k#a"b', new Uint8Array(32)),
      }),
    ).rejects.toThrow(TypeError);
  });
});
