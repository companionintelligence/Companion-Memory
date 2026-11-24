import { generateKeyPairSync } from 'node:crypto';

import { didKeyIdFor } from './didKeyId';
import {
  actorUrlFromWebfinger,
  candidateFromActor,
  parseLocalPubHandle,
  webfingerUrl,
} from './localPubProfile';

/**
 * The documents below are SYNTHETIC: made-up account, made-up domain, freshly generated keys. Their
 * SHAPE is what Local.Pub serves today (observed 2026-11-05): a WebFinger `self` link to an actor at
 * `https://<domain>/did:scid:vh:1:<scid>/actor`, `alsoKnownAs` holding the DIDs, and Mastodon-style
 * profile fields as `PropertyValue` attachments. They embed no real person's identifiers.
 */
const HANDLE = parseLocalPubHandle('@alice@alice.example') as NonNullable<
  ReturnType<typeof parseLocalPubHandle>
>;
const ACTOR_URL = 'https://alice.example/did:scid:vh:1:QmSyntheticSyntheticSyntheticSyntheticSynth/actor';

const newDid = () =>
  didKeyIdFor(
    generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
  ) as string;

const cp = (...codePoints: number[]) => String.fromCodePoint(...codePoints);

function jrd(overrides: Record<string, unknown> = {}) {
  return {
    subject: 'acct:alice@alice.example',
    aliases: [ACTOR_URL, 'https://alice.example/'],
    links: [
      { rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: 'https://alice.example/' },
      { rel: 'self', type: 'application/activity+json', href: ACTOR_URL },
    ],
    ...overrides,
  };
}

function field(name: string, value: string, type = 'PropertyValue') {
  return { type, name, value };
}

function actor(overrides: Record<string, unknown> = {}) {
  return {
    '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/multikey/v1'],
    id: ACTOR_URL,
    type: 'Person',
    preferredUsername: 'alice',
    name: 'Alice Example',
    url: 'https://alice.example/',
    alsoKnownAs: [
      'did:scid:vh:1:QmSyntheticSyntheticSyntheticSyntheticSynth',
      'https://alice.example/',
      'dns:alice.example',
    ],
    attachment: [field('Website', '<a href="https://alice.example/blog" rel="me">alice.example/blog</a>')],
    ...overrides,
  };
}

/** Three 63-character labels and a 61-character one: 253 characters, the longest a host may be. */
const LONGEST_HOST = [
  `${'a'.repeat(63)}`,
  `${'b'.repeat(63)}`,
  `${'c'.repeat(63)}`,
  `${'d'.repeat(61)}`,
].join('.');

describe('parseLocalPubHandle', () => {
  it.each([
    ['@alice@alice.example', 'alice@alice.example'],
    ['alice@alice.example', 'alice@alice.example'],
    ['acct:alice@alice.example', 'alice@alice.example'],
    ['  @Alice@Alice.Example  ', 'Alice@alice.example'],
    ['a.b-c_d@sub.alice.example', 'a.b-c_d@sub.alice.example'],
    ['alice@xn--bcher-kva.example', 'alice@xn--bcher-kva.example'],
    ['alice@a-b.example', 'alice@a-b.example'],
    // The boundaries: a 64-character name, a 63-character label, and a host of exactly 253 characters.
    [`${'a'.repeat(64)}@alice.example`, `${'a'.repeat(64)}@alice.example`],
    [`alice@${'a'.repeat(63)}.example`, `alice@${'a'.repeat(63)}.example`],
    [`alice@${LONGEST_HOST}`, `alice@${LONGEST_HOST}`],
  ])('reads %s', (input, handle) => {
    expect(parseLocalPubHandle(input)?.handle).toBe(handle);
  });

  it.each([
    ['no host', 'alice'],
    ['no name', '@alice.example'],
    ['a second @ and a one-label host', 'alice@bob@alice.example'],
    // Both halves of the second @ are valid on their own, so only the "exactly one @" rule refuses these.
    ['a second @ after a valid host', 'a@alice.example@evil.example'],
    ['a trailing @', 'alice@alice.example@'],
    ['an empty name', '@@alice.example'],
    ['a single-label host', 'alice@localhost'],
    ['an IPv4 literal', 'alice@127.0.0.1'],
    ['a private IPv4 literal', 'alice@192.168.1.10'],
    ['legacy IPv4 (127.1)', 'alice@127.1'],
    ['legacy IPv4 in hex', 'alice@0x7f.1'],
    ['a numeric top label', 'alice@1.2.3'],
    ['an IPv6 literal', 'alice@[::1]'],
    ['a port', 'alice@alice.example:8443'],
    ['the default port spelled out', 'alice@alice.example:443'],
    ['an empty port', 'alice@alice.example:'],
    ['a path', 'alice@alice.example/x'],
    ['a trailing slash', 'alice@alice.example/'],
    ['a query', 'alice@alice.example?x=1'],
    ['a fragment', 'alice@alice.example#x'],
    ['a leading slash in the host', 'alice@/alice.example'],
    ['a backslash in the host', 'alice@\\alice.example'],
    ['credentials', 'alice@user:pw@alice.example'],
    ['a tab inside the host', `alice@ali${cp(9)}ce.example`],
    ['an ideographic full stop', `alice@alice${cp(0x3002)}example`],
    ['percent-encoding in the host', 'alice@alice%2eexample'],
    ['a zero-width space in the host', `alice@ali${cp(0x200b)}ce.example`],
    ['a soft hyphen in the host', `alice@ali${cp(0xad)}ce.example`],
    ['an internationalized host (write it as punycode)', `alice@b${cp(0xfc)}cher.example`],
    ['a Cyrillic look-alike', `alice@${cp(0x430)}pple.com`],
    ['a trailing dot', 'alice@alice.example.'],
    ['two trailing dots', 'alice@alice.example..'],
    ['an empty label', 'alice@alice..example'],
    ['a leading dot', 'alice@.alice.example'],
    ['localhost with trailing dots', 'alice@localhost..'],
    ['a metadata name with trailing dots', 'alice@metadata.google.internal..'],
    ['a label starting with a hyphen', 'alice@-a.example'],
    ['a label ending with a hyphen', 'alice@a-.example'],
    ['an over-long label', `alice@${'a'.repeat(64)}.example`],
    ['a single label of 250 characters', `alice@${'a'.repeat(250)}.example`],
    // Every label is short enough; only the 253-character limit on the whole host refuses it.
    [
      'a host of 254 characters made of short labels',
      `alice@${LONGEST_HOST}x`.replace('d'.repeat(61), 'd'.repeat(62)),
    ],
    // The URL parser reads these as an IPv4 address (or fails on them) although `net.isIP` does not.
    ['an IPv4 address with a hex last part', 'alice@127.0.0.0x1'],
    ['another with a hex last part', 'alice@10.0.0.0xa'],
    ['a name with a hex last label', 'alice@a.0x1'],
    ['a space in the name', 'al ice@alice.example'],
    ['a slash in the name', 'a/b@alice.example'],
    ['a name that starts with a dot', '.alice@alice.example'],
    ['an over-long name', `${'a'.repeat(65)}@alice.example`],
    ['an empty string', ''],
  ])('refuses %s', (_name, input) => {
    expect(parseLocalPubHandle(input)).toBeNull();
  });

  it('folds ASCII only: the Kelvin sign is not a k', () => {
    expect(parseLocalPubHandle(`alice@${cp(0x212a)}eys.example`)).toBeNull();
    expect(parseLocalPubHandle(`alice@Keys.example`)?.handle).toBe('alice@keys.example');
  });

  it('refuses a non-string', () => {
    expect(parseLocalPubHandle(undefined as unknown as string)).toBeNull();
    expect(parseLocalPubHandle(42 as unknown as string)).toBeNull();
  });
});

describe('webfingerUrl', () => {
  it('is always https, on the handle host, at the well-known path', () => {
    expect(webfingerUrl(HANDLE)).toBe(
      'https://alice.example/.well-known/webfinger?resource=acct%3Aalice%40alice.example',
    );
  });
});

describe('actorUrlFromWebfinger', () => {
  it('returns the ActivityPub self link', () => {
    expect(actorUrlFromWebfinger(jrd(), HANDLE)).toBe(ACTOR_URL);
  });

  it('compares the subject case-insensitively and with or without acct:', () => {
    expect(actorUrlFromWebfinger(jrd({ subject: 'ACCT:Alice@Alice.Example' }), HANDLE)).toBe(ACTOR_URL);
    expect(actorUrlFromWebfinger(jrd({ subject: 'alice@alice.example' }), HANDLE)).toBe(ACTOR_URL);
  });

  const selfLink = (href: string) => ({ links: [{ rel: 'self', type: 'application/activity+json', href }] });

  it.each([
    ['an answer about someone else', jrd({ subject: 'acct:mallory@alice.example' })],
    ['an answer about another host', jrd({ subject: 'acct:alice@evil.example' })],
    ['no subject', jrd({ subject: undefined })],
    ['no links', jrd({ links: [] })],
    ['links that are not an array', jrd({ links: 'self' })],
    [
      'only a profile-page link',
      jrd({
        links: [
          { rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: 'https://alice.example/' },
        ],
      }),
    ],
    [
      'a self link that is not ActivityPub',
      jrd({ links: [{ rel: 'self', type: 'text/html', href: ACTOR_URL }] }),
    ],
    ['an actor on another host', jrd(selfLink('https://evil.example/actor'))],
    ['an actor on a subdomain of the host', jrd(selfLink('https://x.alice.example/actor'))],
    ['an actor on a port', jrd(selfLink('https://alice.example:8443/actor'))],
    ['an http actor', jrd(selfLink('http://alice.example/actor'))],
    ['an actor URL with credentials', jrd(selfLink('https://u:p@alice.example/actor'))],
    ['null', null],
    ['an array', []],
    ['a string', 'alice'],
  ])('refuses %s', (_name, body) => {
    expect(actorUrlFromWebfinger(body, HANDLE)).toBeNull();
  });
});

describe('candidateFromActor', () => {
  it('reads what the profile claims and nothing it does not', () => {
    const candidate = candidateFromActor(actor(), HANDLE, ACTOR_URL);

    expect(candidate).toEqual({
      handle: 'alice@alice.example',
      actorId: ACTOR_URL,
      profileUrl: 'https://alice.example/',
      displayName: 'Alice Example',
      claimedDids: ['did:scid:vh:1:QmSyntheticSyntheticSyntheticSyntheticSynth'],
      companionEndpoint: null,
      companionDidKey: null,
    });
  });

  it("does not return the actor's own key, however it is listed", () => {
    const did = newDid();
    const multikey = {
      id: `${ACTOR_URL}#ed25519-key`,
      type: 'Multikey',
      controller: ACTOR_URL,
      publicKeyMultibase: did.slice('did:key:'.length),
    };
    const candidate = candidateFromActor(
      actor({ assertionMethod: [multikey], authentication: [multikey.id] }),
      HANDLE,
      ACTOR_URL,
    );

    expect(candidate).not.toBeNull();
    expect(candidate).not.toHaveProperty('keys');
    // Neither as a key nor, by accident, as a Companion's.
    expect(JSON.stringify(candidate)).not.toContain(did.slice('did:key:'.length));
    expect(candidate?.companionDidKey).toBeNull();
  });

  describe('is not this handle', () => {
    it.each([
      ['an id that is not the URL it was read from', actor({ id: 'https://alice.example/other' })],
      ['an id that is not a string', actor({ id: 42 })],
      ['an id on another host', actor({ id: 'https://evil.example/actor' })],
      ['a type that is not an actor', actor({ type: 'Note' })],
      ['a missing type', actor({ type: undefined })],
      ['a different preferredUsername', actor({ preferredUsername: 'mallory' })],
      ['null', null],
      ['a string', 'alice'],
    ])('%s', (_name, body) => {
      expect(candidateFromActor(body, HANDLE, ACTOR_URL)).toBeNull();
    });

    it('accepts an actor with no preferredUsername, and a Service or Application', () => {
      expect(candidateFromActor(actor({ preferredUsername: undefined }), HANDLE, ACTOR_URL)).not.toBeNull();
      expect(candidateFromActor(actor({ type: 'Service' }), HANDLE, ACTOR_URL)).not.toBeNull();
      expect(candidateFromActor(actor({ type: 'Application' }), HANDLE, ACTOR_URL)).not.toBeNull();
    });

    it('compares the actor id with the WebFinger href as the same URL, not as the same string', () => {
      // Upper-case host and the default port spell the URL the WebFinger href gave.
      const spelledOut = ACTOR_URL.replace('https://alice.example/', 'https://ALICE.example:443/');

      expect(candidateFromActor(actor({ id: spelledOut }), HANDLE, ACTOR_URL)).not.toBeNull();
      expect(candidateFromActor(actor({ id: `${ACTOR_URL}x` }), HANDLE, ACTOR_URL)).toBeNull();
    });
  });

  describe('claimed DIDs', () => {
    it('keeps DIDs of any method as claims, and drops everything else', () => {
      const candidate = candidateFromActor(
        actor({
          alsoKnownAs: [
            'did:web:alice.example',
            'did:webvh:QmSyntheticSyntheticSyntheticSyntheticSynth:alice.example',
            'https://elsewhere.example/@alice',
            'dns:alice.example',
            'did:',
            'did:web:alice.example',
            42,
          ],
        }),
        HANDLE,
        ACTOR_URL,
      );

      expect(candidate?.claimedDids).toEqual([
        'did:web:alice.example',
        'did:webvh:QmSyntheticSyntheticSyntheticSyntheticSynth:alice.example',
      ]);
    });

    it('keeps a DID whose method-specific part is 300 characters and drops one of 301', () => {
      const at = (length: number) => `did:web:${'a'.repeat(length)}`;
      const read = (...dids: string[]) =>
        candidateFromActor(actor({ alsoKnownAs: dids }), HANDLE, ACTOR_URL)?.claimedDids;

      expect(read(at(300))).toEqual([at(300)]);
      expect(read(at(301))).toEqual([]);
    });

    it('reads a single string and caps the list', () => {
      expect(
        candidateFromActor(actor({ alsoKnownAs: 'did:web:alice.example' }), HANDLE, ACTOR_URL)?.claimedDids,
      ).toEqual(['did:web:alice.example']);

      const many = Array.from({ length: 20 }, (_v, i) => `did:web:host${i}.example`);
      expect(candidateFromActor(actor({ alsoKnownAs: many }), HANDLE, ACTOR_URL)?.claimedDids).toHaveLength(
        8,
      );
    });
  });

  describe('the Companion fields', () => {
    const did = newDid();
    const didValue = did;
    const read = (...attachment: unknown[]) => candidateFromActor(actor({ attachment }), HANDLE, ACTOR_URL);

    it('reads an address and a key from one field written as text', () => {
      const candidate = read(field('Companion', `https://m.alice.example/agent/v1 ${did}`));

      expect(candidate?.companionEndpoint).toBe('https://m.alice.example/agent/v1');
      expect(candidate?.companionDidKey).toBe(did);
    });

    it('reads an address from an HTML link, as Local.Pub renders a link field', () => {
      const candidate = read(
        field('Companion', '<a href="https://m.alice.example/agent/v1" rel="me">m.alice.example</a>'),
      );

      expect(candidate?.companionEndpoint).toBe('https://m.alice.example/agent/v1');
      expect(candidate?.companionDidKey).toBeNull();
    });

    it('never assembles a pair from two fields: an address in one and a key in another gives the first field only', () => {
      const candidate = read(
        field('My Companion', 'https://m.alice.example/agent/v1'),
        field('companion key', did),
      );

      expect(candidate?.companionEndpoint).toBe('https://m.alice.example/agent/v1');
      expect(candidate?.companionDidKey).toBeNull();
    });

    it('does not lend a retired field address to the current key', () => {
      const candidate = read(
        field('Companion (old)', 'https://old.example/agent/v1'),
        field('Companion', `https://new.example/agent/v1 ${did}`),
      );

      // The second field holds BOTH, so it is the pair; the old field's address stays where it was.
      expect(candidate?.companionEndpoint).toBe('https://new.example/agent/v1');
      expect(candidate?.companionDidKey).toBe(did);
    });

    it('takes the first field that holds either when none holds both, and never the key of a later one', () => {
      const candidate = read(
        field('Companion (old)', 'https://old.example/agent/v1'),
        field('Companion key', did),
      );

      expect(candidate?.companionEndpoint).toBe('https://old.example/agent/v1');
      expect(candidate?.companionDidKey).toBeNull();
    });

    it.each(['Companion', 'companion', 'My COMPANION box', 'Companion key'])(
      'matches a field named %s',
      (name) => {
        expect(read(field(name, `https://m.alice.example/agent/v1 ${did}`))?.companionDidKey).toBe(did);
      },
    );

    it('keeps the first of several addresses and keys', () => {
      const other = newDid();
      const candidate = read(
        field('Companion', `https://one.example/agent/v1 ${did}`),
        field('Companion', `https://two.example/agent/v1 ${other}`),
      );

      expect(candidate?.companionEndpoint).toBe('https://one.example/agent/v1');
      expect(candidate?.companionDidKey).toBe(did);
    });

    it('skips a candidate that is not usable and takes the next one in the same field', () => {
      const x25519 = 'did:key:z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc';
      const candidate = read(
        field(
          'Companion',
          `${x25519} http://insecure.example/ https://u:p@cred.example/ https://ok.example/agent/v1 ${did}`,
        ),
      );

      expect(candidate?.companionEndpoint).toBe('https://ok.example/agent/v1');
      expect(candidate?.companionDidKey).toBe(did);
    });

    it.each([
      ['a field that is not named for a Companion', field('Website', `https://m.alice.example/ ${did}`)],
      ['a field that is not a PropertyValue', field('Companion', `https://m.alice.example/ ${did}`, 'Link')],
      ['only an http address', field('Companion', 'http://m.alice.example/agent/v1')],
      ['only an address with credentials', field('Companion', 'https://u:p@m.alice.example/')],
      ['only a javascript: link', field('Companion', '<a href="javascript:alert(1)">x</a>')],
      ['text with no address or key', field('Companion', 'ask me')],
      ['an over-long address', field('Companion', `https://m.alice.example/${'a'.repeat(3000)}`)],
      [
        'a key for another key type',
        field('Companion', 'did:key:z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc'),
      ],
      ['a did:keri', field('Companion', 'did:keri:D6Zwb8HfPqmyZXwMt1k0fKQPwoSTmN2GqmXdB2eyd1Mq')],
      ['a did:web', field('Companion', 'did:web:alice.example')],
      ['a weak key', field('Companion', 'did:key:z6MkeTG3bFFSLYVU7VqhgZxqr6YzpaGrQtFMh1uvqGy1vDnP')],
    ])('claims nothing from %s', (_name, entry) => {
      const candidate = read(entry);

      expect(candidate?.companionEndpoint).toBeNull();
      expect(candidate?.companionDidKey).toBeNull();
    });

    it('reads a value of 2,048 characters and reads nothing from one of 2,049', () => {
      const pad = (length: number) => ' '.repeat(length - `https://ok.example/agent/v1 ${did}`.length);
      const sized = (length: number) => `${pad(length)}https://ok.example/agent/v1 ${did}`;

      expect(sized(2048)).toHaveLength(2048);
      expect(read(field('Companion', sized(2048)))?.companionEndpoint).toBe('https://ok.example/agent/v1');

      const over = read(field('Companion', sized(2049)));
      expect(over?.companionEndpoint).toBeNull();
      expect(over?.companionDidKey).toBeNull();
    });

    it('never reads an address cut short: a long value is skipped whole', () => {
      const long = `https://m.alice.example/${'a'.repeat(2100)}`;

      expect(read(field('Companion', long))?.companionEndpoint).toBeNull();
    });

    it('reads the 32nd attachment and not the 33rd', () => {
      const filler = (count: number) => Array.from({ length: count }, (_v, i) => field(`Field ${i}`, 'x'));
      const companion = field('Companion', `https://late.example/agent/v1 ${did}`);

      expect(read(...filler(31), companion)?.companionEndpoint).toBe('https://late.example/agent/v1');
      expect(read(...filler(32), companion)?.companionEndpoint).toBeNull();
    });

    it('does not offer an address with a query or a fragment as the base: /ask would be swallowed by it', () => {
      for (const address of [
        'https://m.alice.example/agent/v1?x=1',
        'https://m.alice.example/agent/v1#frag',
        'https://m.alice.example/agent/v1#',
        `https://m.alice.example/agent/v1#${didValue}`,
      ]) {
        expect([address, read(field('Companion', `${address} ${didValue}`))?.companionEndpoint]).toEqual([
          address,
          null,
        ]);
      }

      // The next candidate in the same field is taken, and the key is still read from it.
      const candidate = read(
        field('Companion', `https://m.alice.example/agent/v1?x=1 https://ok.example/agent/v1 ${didValue}`),
      );
      expect(candidate?.companionEndpoint).toBe('https://ok.example/agent/v1');
      expect(candidate?.companionDidKey).toBe(didValue);
    });

    it.each([
      ['a single-quoted href', `<a href='https://sq.example/agent/v1'>x</a>`],
      ['an upper-case HREF attribute', `<a HREF="https://uc.example/agent/v1">x</a>`],
      ['an upper-case scheme and host in a bare address', 'HTTPS://BARE.EXAMPLE/agent/v1'],
      ['an address followed by markup', 'https://tag.example/agent/v1</a><b>'],
    ])("reads an address from %s, in the URL parser's canonical form", (_name, value) => {
      const endpoint = read(field('Companion', value))?.companionEndpoint;

      expect(endpoint).toMatch(/^https:\/\/[a-z]+\.example\/agent\/v1$/);
    });

    it.each([
      ['a user name only', 'https://user@m.example/agent/v1'],
      ['a password only', 'https://:secret@m.example/agent/v1'],
    ])('refuses an address with %s', (_name, address) => {
      expect(read(field('Companion', address))?.companionEndpoint).toBeNull();
    });

    it('prefers the target of a link to a bare address in the same value', () => {
      const candidate = read(
        field('Companion', 'https://bare.example/agent/v1 <a href="https://linked.example/agent/v1">x</a>'),
      );

      expect(candidate?.companionEndpoint).toBe('https://linked.example/agent/v1');
    });

    it.each([
      ['a number', 42],
      ['null', null],
      ['an object', { href: 'https://m.alice.example/' }],
    ])('claims nothing from a field whose value is %s, and does not throw', (_name, value) => {
      const candidate = read({ type: 'PropertyValue', name: 'Companion', value });

      expect(candidate?.companionEndpoint).toBeNull();
      expect(candidate?.companionDidKey).toBeNull();
    });

    it('skips attachment entries that are not objects, and a field whose name is not a string', () => {
      const candidate = read(
        null,
        'x',
        7,
        { type: 'PropertyValue', name: 42, value: `https://m.alice.example/ ${did}` },
        field('Companion', `https://ok.example/agent/v1 ${did}`),
      );

      expect(candidate?.companionEndpoint).toBe('https://ok.example/agent/v1');
    });

    it('claims nothing from an address that does not parse, and does not throw', () => {
      expect(read(field('Companion', 'https://[bad'))?.companionEndpoint).toBeNull();
    });

    it('is null when the actor has no attachments, or a single one that is not an array', () => {
      expect(
        candidateFromActor(actor({ attachment: undefined }), HANDLE, ACTOR_URL)?.companionEndpoint,
      ).toBeNull();
      expect(
        candidateFromActor(
          actor({ attachment: field('Companion', 'https://one.example/agent/v1') }),
          HANDLE,
          ACTOR_URL,
        )?.companionEndpoint,
      ).toBe('https://one.example/agent/v1');
    });
  });

  describe('the display name', () => {
    const name = (value: unknown) =>
      candidateFromActor(actor({ name: value }), HANDLE, ACTOR_URL)?.displayName;

    it('removes controls, bidi formatting, zero-width and tag characters, and line separators', () => {
      expect(name(`  Al${cp(0)}ice${cp(0x1b)}[31m ${cp(7)}`)).toBe('Alice[31m');
      expect(name(`Al${cp(0x202e)}ice`)).toBe('Alice');
      expect(name(`Al${cp(0x2066)}i${cp(0x2069)}ce${cp(0x200f)}`)).toBe('Alice');
      expect(name(`Al${cp(0x200b)}ice${cp(0xfeff)}`)).toBe('Alice');
      expect(name(`Al${cp(0xfeff)}ice`)).toBe('Alice');
      expect(name(`Alice${cp(0xe0041, 0xe0042)}`)).toBe('Alice');
      expect(name(`Ali${cp(0x2028)}ce${cp(0x2029)}`)).toBe('Alice');
      expect(name(`Ali${cp(0x85)}ce`)).toBe('Alice');
      expect(name(`Al${cp(0x7f)}i${cp(0x80)}c${cp(0x84)}e`)).toBe('Alice');
      expect(name(`Al${cp(0x2060, 0x2061, 0x2062, 0x2063, 0x2064)}ice`)).toBe('Alice');
    });

    it('removes every code point that renders as nothing, between two letters: the whole Default_Ignorable set', () => {
      const ignorable = /\p{Default_Ignorable_Code_Point}/u;
      let checked = 0;

      for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
          continue;
        }

        const char = String.fromCodePoint(codePoint);
        if (ignorable.test(char)) {
          checked += 1;
          expect([codePoint.toString(16), name(`A${char}B`)]).toEqual([codePoint.toString(16), 'AB']);
        }
      }

      // The set is a few thousand code points; a pattern that matched nothing would pass the loop.
      expect(checked).toBeGreaterThan(4000);
    });

    it('removes every bidi control, including the Arabic letter mark', () => {
      const bidi = /\p{Bidi_Control}/u;
      let checked = 0;

      for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
          continue;
        }

        const char = String.fromCodePoint(codePoint);
        if (bidi.test(char)) {
          checked += 1;
          expect([codePoint.toString(16), name(`A${char}B`)]).toEqual([codePoint.toString(16), 'AB']);
        }
      }

      expect(checked).toBe(12);
      expect(name(`Al${cp(0x61c)}ice`)).toBe('Alice');
    });

    it('removes the invisible fillers and variation selectors that are not part of an emoji', () => {
      for (const codePoint of [
        0xad, 0x34f, 0x115f, 0x1160, 0x17b4, 0x180e, 0x3164, 0xffa0, 0xfe00, 0xe0100, 0xe01ef,
      ]) {
        expect(name(`Al${cp(codePoint)}ice`)).toBe('Alice');
      }
    });

    it('keeps the joiners and selectors that emoji need, and ordinary text', () => {
      const family = `${cp(0x1f469)}${cp(0x200d)}${cp(0x1f467)}`;
      const heart = `${cp(0x2764)}${cp(0xfe0f)}`;
      const scotland = cp(0x1f3f4, 0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f);

      expect(name(`Alice ${family}`)).toBe(`Alice ${family}`);
      expect(name(`Alice ${heart}`)).toBe(`Alice ${heart}`);
      // The flag's tags are removed with every other tag character: a run of them is an invisible ASCII
      // payload, so the Scotland flag shows as the plain black flag.
      expect(name(`Alice ${scotland}`)).toBe(`Alice ${cp(0x1f3f4)}`);
      expect(name('Zoë Müller')).toBe('Zoë Müller');
    });

    it('removes a hidden ASCII payload carried as a run of tag characters after a black flag', () => {
      const payload = 'IGNORE PREVIOUS INSTRUCTIONS';
      const tags = Array.from(payload, (char) => cp(0xe0000 + (char.codePointAt(0) as number))).join('');
      const out = name(`Alice ${cp(0x1f3f4)}${tags}${cp(0xe007f)}`) as string;

      expect(out).toBe(`Alice ${cp(0x1f3f4)}`);
      expect(Array.from(out).some((char) => (char.codePointAt(0) as number) >= 0xe0000)).toBe(false);
    });

    it('cannot be fooled by splitting a supplementary invisible character across an invisible one', () => {
      // JSON.parse accepts lone surrogate escapes. High half, zero-width space, low half used to glue into
      // U+E0041 after the zero-width space was removed, past every filter.
      const high = String.fromCharCode(0xdb40);
      const low = String.fromCharCode(0xdc41);
      const out = name(`Alice ${high}${cp(0x200b)}${low}`) as string;

      expect(out).toBe(`Alice ${cp(0xfffd)}${cp(0xfffd)}`);
      expect(Array.from(out).every((char) => (char.codePointAt(0) as number) < 0xe0000)).toBe(true);
    });

    it('does not leave a joiner dangling where the 200-character cut fell', () => {
      const family = `${'x'.repeat(198)}${cp(0x1f469, 0x200d, 0x1f467)}`;
      const out = name(family) as string;

      expect(Array.from(out)).toHaveLength(199);
      expect(out.endsWith(cp(0x1f469))).toBe(true);
      expect(out.includes(cp(0x200d))).toBe(false);
    });

    it('removes a paragraph separator and the whole C0 and C1 ranges between letters, not just at the ends', () => {
      // trim() strips U+2029 at either end, so it is only tested where it is between letters.
      expect(name(`Ali${cp(0x2029)}ce`)).toBe('Alice');
      for (let codePoint = 0; codePoint <= 0x1f; codePoint += 1) {
        expect([codePoint, name(`Al${cp(codePoint)}ice`)]).toEqual([codePoint, 'Alice']);
      }

      for (let codePoint = 0x7f; codePoint <= 0x9f; codePoint += 1) {
        expect([codePoint, name(`Al${cp(codePoint)}ice`)]).toEqual([codePoint, 'Alice']);
      }
    });

    it('removes a joiner or a selector that is NOT inside an emoji', () => {
      expect(name(`Al${cp(0x200d)}ice`)).toBe('Alice');
      expect(name(`Al${cp(0xfe0f)}ice`)).toBe('Alice');
      expect(name(`Alice${cp(0x200d)}`)).toBe('Alice');
    });

    it('is null for text that is nothing once cleaned, and for a non-string', () => {
      expect(name(cp(0))).toBeNull();
      expect(name(`${cp(0x202e)}${cp(0x200b)}`)).toBeNull();
      expect(name('   ')).toBeNull();
      expect(name(42)).toBeNull();
    });

    it('caps the length in characters, not in code units', () => {
      expect(name('x'.repeat(500))).toHaveLength(200);
      expect(Array.from(name(cp(0x1f600).repeat(300)) as string)).toHaveLength(200);
    });
  });

  it('keeps a profile URL of exactly 2,048 characters and drops one of 2,049', () => {
    const prefix = 'https://alice.example/';
    const url = (length: number) => `${prefix}${'a'.repeat(length - prefix.length)}`;

    expect(candidateFromActor(actor({ url: url(2048) }), HANDLE, ACTOR_URL)?.profileUrl).toBe(url(2048));
    expect(candidateFromActor(actor({ url: url(2049) }), HANDLE, ACTOR_URL)?.profileUrl).toBeNull();
  });

  it('drops a profile URL that is too long or is not a URL, without throwing', () => {
    expect(
      candidateFromActor(actor({ url: `https://alice.example/${'a'.repeat(3000)}` }), HANDLE, ACTOR_URL)
        ?.profileUrl,
    ).toBeNull();
    expect(candidateFromActor(actor({ url: 'not a url' }), HANDLE, ACTOR_URL)?.profileUrl).toBeNull();
    expect(candidateFromActor(actor({ url: 'https://' }), HANDLE, ACTOR_URL)?.profileUrl).toBeNull();
  });

  it('drops a profile URL that is not https', () => {
    expect(
      candidateFromActor(actor({ url: 'http://alice.example/' }), HANDLE, ACTOR_URL)?.profileUrl,
    ).toBeNull();
    expect(
      candidateFromActor(actor({ url: ['https://alice.example/'] }), HANDLE, ACTOR_URL)?.profileUrl,
    ).toBeNull();
  });
});

describe('WebFinger and actor shapes a real server may send', () => {
  const link = (overrides: Record<string, unknown> = {}) => ({
    rel: 'self',
    type: 'application/activity+json',
    href: ACTOR_URL,
    ...overrides,
  });

  it('accepts the ld+json media type with a profile, and the activity+json one', () => {
    expect(
      actorUrlFromWebfinger(
        jrd({
          links: [link({ type: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"' })],
        }),
        HANDLE,
      ),
    ).toBe(ACTOR_URL);
    expect(actorUrlFromWebfinger(jrd({ links: [link()] }), HANDLE)).toBe(ACTOR_URL);
  });

  it.each([
    ['a link that is not the self link', { links: [link({ rel: 'alternate' })] }],
    ['a self link that is a web page', { links: [link({ type: 'text/html' })] }],
    ['a self link with no type', { links: [link({ type: undefined })] }],
    ['a self link with no href', { links: [link({ href: undefined })] }],
    ['a self link whose href is not a string', { links: [link({ href: 42 })] }],
    ['no links at all', { links: undefined }],
    ['links that are not a list', { links: 'self' }],
    ['a subject that is not a string', { subject: 42 }],
  ])('finds no actor in %s', (_name, overrides) => {
    expect(actorUrlFromWebfinger(jrd(overrides), HANDLE)).toBeNull();
  });

  it('skips an entry that is not an object and reads the self link after it', () => {
    expect(actorUrlFromWebfinger(jrd({ links: [null, 'x', 7, link()] }), HANDLE)).toBe(ACTOR_URL);
  });

  it('answers a handle typed with capitals, against a subject in lower case', () => {
    const typed = parseLocalPubHandle('ACCT:Alice@Alice.Example') as NonNullable<
      ReturnType<typeof parseLocalPubHandle>
    >;

    expect(actorUrlFromWebfinger(jrd(), typed)).toBe(ACTOR_URL);
  });

  it('does not fold the Kelvin sign into a k, in the subject or in the username', () => {
    const keys = parseLocalPubHandle('kate@keys.example') as NonNullable<
      ReturnType<typeof parseLocalPubHandle>
    >;
    const keysActor = 'https://keys.example/actor';

    expect(
      actorUrlFromWebfinger(
        { subject: `acct:kate@${cp(0x212a)}eys.example`, links: [link({ href: keysActor })] },
        keys,
      ),
    ).toBeNull();
    expect(
      actorUrlFromWebfinger({ subject: 'acct:kate@keys.example', links: [link({ href: keysActor })] }, keys),
    ).toBe(keysActor);

    const kate = parseLocalPubHandle('kate@alice.example') as NonNullable<
      ReturnType<typeof parseLocalPubHandle>
    >;
    expect(candidateFromActor(actor({ preferredUsername: `${cp(0x212a)}ate` }), kate, ACTOR_URL)).toBeNull();
    expect(candidateFromActor(actor({ preferredUsername: 'Kate' }), kate, ACTOR_URL)).not.toBeNull();
  });

  it.each([
    ['an id that is an array', { id: [ACTOR_URL] }],
    ['an id that is a number', { id: 42 }],
    ['a type that is a group', { type: 'Group' }],
    ['no type', { type: undefined }],
  ])('refuses an actor with %s', (_name, overrides) => {
    expect(candidateFromActor(actor(overrides), HANDLE, ACTOR_URL)).toBeNull();
  });

  it.each([
    ['null', null],
    ['a number', 42],
  ])('ignores a preferredUsername that is %s, as the field is optional', (_name, preferredUsername) => {
    expect(candidateFromActor(actor({ preferredUsername }), HANDLE, ACTOR_URL)).not.toBeNull();
  });

  it('keeps the DIDs that fit the grammar and drops the ones that do not', () => {
    const fits = ['did:web:ex-ample.com', 'did:ion2:abc_DEF-1%3A', `did:scid:vh:1:${'Q'.repeat(40)}`];
    const doesNot = [
      'did:web:has space',
      ' did:web:x',
      'did:web:x ',
      'did:web:',
      'did:WEB:x',
      'web:x',
      'did:web:x\ny',
    ];
    const out = candidateFromActor(
      actor({ alsoKnownAs: [...doesNot, ...fits, 42, null, ['did:web:x']] }),
      HANDLE,
      ACTOR_URL,
    )?.claimedDids;

    expect(out).toEqual(fits);
  });
});

describe('the handle grammar, boundary by boundary', () => {
  it.each([
    ['a digit in the name', 'a1@alice.example'],
    ['an underscore first', '_a@alice.example'],
    ['capitals after the first character', 'aLiCe@alice.example'],
    ['dots and hyphens inside', 'a.b-c@alice.example'],
    ['a top-level label of 63 characters', `alice@alice.${'a'.repeat(63)}`],
    ['ACCT: in capitals', 'ACCT:alice@alice.example'],
  ])('reads %s', (_name, input) => {
    expect(parseLocalPubHandle(input)).not.toBeNull();
  });

  it.each([
    ['a hyphen first', '-a@alice.example'],
    ['a top-level label of 64 characters', `alice@alice.${'a'.repeat(64)}`],
    ['a top-level label that starts with a hyphen', 'alice@alice.-com'],
    ['a top-level label that ends with a hyphen', 'alice@alice.com-'],
  ])('refuses %s', (_name, input) => {
    expect(parseLocalPubHandle(input)).toBeNull();
  });
});
