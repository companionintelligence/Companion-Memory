import { RUST_PLAINTEXT } from './__tests__/rustVectors';
import { PLAINTEXT } from './__tests__/vectors';
import { DidcommError } from './errors';
import {
  type Attachment,
  attachmentBytes,
  createMessage,
  isExpired,
  MEDIA_TYPE,
  mediaTypeMatches,
  parseMessage,
  parseMessageJson,
  threadIdOf,
} from './message';

describe('parseMessage', () => {
  it('accepts the specification plaintext message untouched', () => {
    const parsed = parseMessage(PLAINTEXT);

    expect(parsed).toBe(PLAINTEXT);
    expect(parsed.type).toBe('https://example.com/protocols/lets_do_lunch/1.0/proposal');
    expect(parsed.to).toEqual(['did:example:bob']);
  });

  it.each([
    'PLAINTEXT_MSG_SIMPLE',
    'PLAINTEXT_MSG_SIMPLE_NO_TYP',
    'PLAINTEXT_MSG_MINIMAL',
    'PLAINTEXT_FROM_PRIOR',
    'PLAINTEXT_INVALID_FROM_PRIOR',
    'PLAINTEXT_FROM_PRIOR_INVALID_SIGNATURE',
    'PLAINTEXT_MSG_ATTACHMENT_BASE64',
    'PLAINTEXT_MSG_ATTACHMENT_LINKS',
    'PLAINTEXT_MSG_ATTACHMENT_JSON',
    'PLAINTEXT_MSG_ATTACHMENT_MULTI_1',
    'PLAINTEXT_MSG_ATTACHMENT_MULTI_2',
  ])('accepts the reference implementation vector %s', (name) => {
    expect(() => parseMessageJson(RUST_PLAINTEXT[name])).not.toThrow();
  });

  it.each([
    'INVALID_PLAINTEXT_MSG_EMPTY',
    'INVALID_PLAINTEXT_MSG_STRING',
    'INVALID_PLAINTEXT_MSG_NO_ID',
    'INVALID_PLAINTEXT_MSG_NO_TYPE',
    'INVALID_PLAINTEXT_MSG_WRONG_TYP',
    'INVALID_PLAINTEXT_MSG_EMPTY_ATTACHMENTS',
    'INVALID_PLAINTEXT_MSG_ATTACHMENTS_NO_DATA',
    'INVALID_PLAINTEXT_MSG_ATTACHMENTS_EMPTY_DATA',
    'INVALID_PLAINTEXT_MSG_ATTACHMENTS_LINKS_NO_HASH',
    'INVALID_PLAINTEXT_MSG_ATTACHMENTS_AS_STRING',
    'INVALID_PLAINTEXT_MSG_ATTACHMENTS_AS_INT_ARRAY',
    'INVALID_PLAINTEXT_MSG_ATTACHMENTS_WRONG_DATA',
    'INVALID_PLAINTEXT_MSG_ATTACHMENTS_WRONG_ID',
    'INVALID_PLAINTEXT_MSG_ATTACHMENTS_NULL_DATA',
  ])('rejects the reference implementation vector %s', (name) => {
    expect(() => parseMessageJson(RUST_PLAINTEXT[name])).toThrow(DidcommError);
  });

  it('accepts a message without body, as DIDComm v2.1 allows on receipt (v2.0 required it)', () => {
    const parsed = parseMessageJson(RUST_PLAINTEXT.INVALID_PLAINTEXT_MSG_NO_BODY);

    expect(parsed.body).toBeUndefined();
  });

  it('leaves the body exactly as received, key order and numbers included', () => {
    const text = '{"id":"a","type":"https://x.example/p/1.0/m","body":{"z":1,"a":[1.50,2e3],"n":null}}';
    const parsed = parseMessageJson(text);

    expect(JSON.stringify(parsed.body)).toBe('{"z":1,"a":[1.5,2000],"n":null}');
    expect(Object.keys(parsed.body ?? {})).toEqual(['z', 'a', 'n']);
  });

  it('keeps unknown headers', () => {
    const parsed = parseMessage({
      id: 'a',
      type: 'https://x.example/p/1.0/m',
      body: {},
      return_route: 'all',
      'x-custom': { deep: true },
    });

    expect(parsed.return_route).toBe('all');
    expect(parsed['x-custom']).toEqual({ deep: true });
  });

  it.each([
    ['an id with a space', { id: 'a b' }],
    ['an id with a newline', { id: 'a\nb' }],
    ['an id with non-ASCII', { id: 'ä' }],
    ['an over-long id', { id: 'a'.repeat(257) }],
    ['a numeric id', { id: 5 }],
    ['an over-long type', { type: `https://x.example/${'a'.repeat(600)}` }],
    ['a type with whitespace', { type: 'https://x.example/p 1' }],
    ['a from that is a key', { from: 'did:example:alice#key-1' }],
    ['a from that is not a DID', { from: 'alice' }],
    ['an empty to', { to: [] }],
    ['a to that is a string', { to: 'did:example:bob' }],
    ['a to entry that is a key', { to: ['did:example:bob#key-1'] }],
    ['too many recipients', { to: Array.from({ length: 101 }, (_, i) => `did:example:r${i}`) }],
    ['a thid with a space', { thid: 'a b' }],
    ['a fractional created_time', { created_time: 1.5 }],
    ['a negative expires_time', { expires_time: -1 }],
    ['a string created_time', { created_time: '1516269022' }],
    ['a body that is an array', { body: [] }],
    ['a null body', { body: null }],
    ['a from_prior that is an object', { from_prior: {} }],
    ['too many attachments', { attachments: Array.from({ length: 65 }, () => ({ data: { json: {} } })) }],
    ['a "__proto__" member', JSON.parse('{"__proto__":{"x":1}}')],
  ])('rejects %s', (_name, overrides) => {
    expect(() =>
      parseMessage({ id: 'a', type: 'https://x.example/p/1.0/m', body: {}, ...overrides }),
    ).toThrow(DidcommError);
  });

  it('rejects non-objects', () => {
    for (const value of [null, 'x', 5, [], undefined]) {
      expect(() => parseMessage(value)).toThrow(DidcommError);
    }
  });
});

describe('media types', () => {
  it('applies the RFC 7515 rule that a missing "application/" prefix is implied', () => {
    expect(mediaTypeMatches('application/didcomm-plain+json', MEDIA_TYPE.plain)).toBe(true);
    expect(mediaTypeMatches('didcomm-plain+json', MEDIA_TYPE.plain)).toBe(true);
    expect(mediaTypeMatches('Application/DIDComm-Plain+JSON', MEDIA_TYPE.plain)).toBe(true);
    expect(mediaTypeMatches('application/didcomm-plain+json-unknown', MEDIA_TYPE.plain)).toBe(false);
    expect(mediaTypeMatches('application/didcomm-signed+json', MEDIA_TYPE.plain)).toBe(false);
    expect(mediaTypeMatches(undefined, MEDIA_TYPE.plain)).toBe(false);
    expect(mediaTypeMatches('', MEDIA_TYPE.plain)).toBe(false);
  });
});

describe('createMessage', () => {
  it('fills a UUID id, the plain media type, the time and an empty body', () => {
    const message = createMessage({ type: 'https://didcomm.org/trust-ping/2.0/ping' }, 1700000000);

    expect(message.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(message).toMatchObject({
      typ: MEDIA_TYPE.plain,
      type: 'https://didcomm.org/trust-ping/2.0/ping',
      created_time: 1700000000,
      body: {},
    });
    expect(Object.keys(message)).toEqual(['id', 'typ', 'type', 'created_time', 'body']);
  });

  it('puts fields in the order the specification examples use', () => {
    const message = createMessage(
      {
        type: 'https://x.example/p/1.0/m',
        from: 'did:example:alice',
        to: ['did:example:bob'],
        thid: 't1',
        pthid: 'p1',
        expires_time: 1700000100,
        body: { a: 1 },
        headers: { return_route: 'all' },
      },
      1700000000,
    );

    expect(Object.keys(message)).toEqual([
      'id',
      'typ',
      'type',
      'from',
      'to',
      'thid',
      'pthid',
      'created_time',
      'expires_time',
      'body',
      'return_route',
    ]);
  });

  it('validates what it builds and refuses to shadow a defined header', () => {
    expect(() => createMessage({ type: 'https://x.example/p/1.0/m', to: ['not a did'] })).toThrow(
      DidcommError,
    );
    expect(() => createMessage({ type: 'https://x.example/p/1.0/m', headers: { thid: 'x' } })).toThrow(
      /defined header/,
    );
  });

  it('never repeats an id', () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => createMessage({ type: 'https://x.example/p/1.0/m' }).id),
    );

    expect(ids.size).toBe(50);
  });
});

describe('thread and expiry helpers', () => {
  const base = parseMessage({ id: 'm1', type: 'https://x.example/p/1.0/m', body: {} });

  it('uses the id as the thread when there is no thid', () => {
    expect(threadIdOf(base)).toBe('m1');
    expect(threadIdOf({ ...base, thid: 't9' })).toBe('t9');
  });

  it('treats a message with no expires_time as unexpired and allows for skew', () => {
    expect(isExpired(base, 5000)).toBe(false);
    expect(isExpired({ ...base, expires_time: 1000 }, 1001)).toBe(true);
    expect(isExpired({ ...base, expires_time: 1000 }, 1000)).toBe(false);
    expect(isExpired({ ...base, expires_time: 1000 }, 1050, 60)).toBe(false);
    expect(isExpired({ ...base, expires_time: 1000 }, 1061, 60)).toBe(true);
  });
});

describe('attachments', () => {
  it('decodes base64 and base64url, padded or not', () => {
    const make = (base64: string): Attachment => ({ data: { base64 } });

    expect(attachmentBytes(make('WW91ciBob3ZlcmNyYWZ0IGlzIGZ1bGwgb2YgZWVscw=='))?.toString()).toBe(
      'Your hovercraft is full of eels',
    );
    expect(attachmentBytes(make('WW91ciBob3ZlcmNyYWZ0IGlzIGZ1bGwgb2YgZWVscw'))?.toString()).toBe(
      'Your hovercraft is full of eels',
    );
    expect(attachmentBytes(make('-_8'))).toEqual(Buffer.from([0xfb, 0xff]));
    expect(attachmentBytes({ data: { json: {} } })).toBeUndefined();
  });

  it('accepts links only together with a hash', () => {
    const base = { id: 'a', type: 'https://x.example/p/1.0/m', body: {} };

    expect(() =>
      parseMessage({ ...base, attachments: [{ data: { links: ['https://x.example/f'] } }] }),
    ).toThrow(/hash/);
    expect(() =>
      parseMessage({ ...base, attachments: [{ data: { links: ['https://x.example/f'], hash: 'QmHash' } }] }),
    ).not.toThrow();
  });
});
