import type { Entity, Item } from '../../datasources/timeline';
import {
  CONTACT_IDENTIFIER_KEYS,
  CONTACT_NAMES_KEY,
  contactIdentifiers,
  entityIdentityKey,
  entityKey,
  FAX_ATTRIBUTE_NAME,
  hasContactIdentity,
  hashItem,
  isOrganizationalAddress,
  isShortCode,
  legacyEntityIdentityKey,
  markSharedContactHandles,
  mergeAccumulatedMetadata,
  namesDescribeDifferentPeople,
  needsContentDigest,
  normalizeHandle,
  ORGANIZATIONAL_STAGED_TYPE,
  resolveEntityType,
  withContactIdentifiers,
} from '../identity';

/**
 * These functions decide what collapses into what, which is the whole of
 * within-run dedup. Every case here is one a real export produced:
 *
 *  - one photo replicated across three album folders must stage once;
 *  - one person spelled three ways in a mailbox must stage once;
 *  - two genuinely different things must NOT collapse, which is the half that
 *    silently loses data when it goes wrong.
 */

describe('normalizeHandle', () => {
  it('lower-cases an email so display casing cannot fork a person', () => {
    expect(normalizeHandle('Alice@Example.COM')).toBe('alice@example.com');
  });

  it('reduces a phone number to its last ten digits, whatever the formatting', () => {
    const forms = ['+1 (555) 010-9999', '555-010-9999', '15550109999', '+1.555.010.9999'];

    expect(new Set(forms.map(normalizeHandle)).size).toBe(1);
    expect(normalizeHandle(forms[0])).toBe('5550109999');
  });

  it('rejects a bare name and a too-short number — neither identifies anyone', () => {
    expect(normalizeHandle('Alice Smith')).toBe('');
    expect(normalizeHandle('12345')).toBe('');
    expect(normalizeHandle('')).toBe('');
    expect(normalizeHandle(undefined)).toBe('');
  });
});

describe('entityIdentityKey', () => {
  it('is independent of attribute order, so from/to/cc surface one person the same way', () => {
    const asFrom: Entity = {
      name: 'Alice',
      attributes: [
        { name: 'email', value: 'alice@example.com' },
        { name: 'phone', value: '+1 555 010 9999' },
      ],
    };
    const asRecipient: Entity = {
      name: 'Alice Smith',
      attributes: [
        { name: 'phone', value: '555-010-9999' },
        { name: 'email', value: 'ALICE@example.com' },
      ],
    };

    expect(entityIdentityKey(asFrom)).toBe(entityIdentityKey(asRecipient));
  });

  it('reads an identity-flagged attribute that carries no recognisable name', () => {
    // apple_contacts emits exactly this shape.
    const entity: Entity = { attributes: [{ name: '', value: '+1 555 010 9999', identity: true }] };

    expect(entityIdentityKey(entity)).toBe('5550109999');
  });

  it('is null for an entity with no handle at all', () => {
    expect(entityIdentityKey({ name: 'European Vacation', type: 'album' })).toBeNull();
  });

  it('passes over a shared handle even when it sorts first', () => {
    // The office switchboard sorts below the person's own address — digits
    // before letters — and used to be the key.
    const entity: Entity = {
      name: 'Priya Natarajan',
      attributes: [
        { name: 'phone', value: '(555) 010-0100', identity: true, shared: true },
        { name: 'email', value: 'priya@example.com', identity: true },
      ],
    };

    expect(entityIdentityKey(entity)).toBe('priya@example.com');
    expect(legacyEntityIdentityKey(entity)).toBe('5550100100');
  });

  it('keys a named contact on its NAME when every handle it has is shared', () => {
    const entity: Entity = {
      name: 'Tom Becker',
      attributes: [{ name: 'phone', value: '555-010-0100', identity: true, shared: true }],
    };

    // null here is what sends stagedNaturalKey to `contact:tom becker`.
    expect(entityIdentityKey(entity)).toBeNull();
    // Still a contact: the switchboard is still how to reach him.
    expect(hasContactIdentity(entity)).toBe(true);
  });

  it('falls back to the smallest shared handle only for a nameless contact', () => {
    const entity: Entity = {
      name: '  ',
      attributes: [
        { name: 'phone', value: '555-010-0199', identity: true, shared: true },
        { name: 'phone', value: '555-010-0100', identity: true, shared: true },
      ],
    };

    expect(entityIdentityKey(entity)).toBe('5550100100');
  });
});

describe('legacyEntityIdentityKey', () => {
  it('is the smallest of every handle, shared or not — the rule existing rows were minted under', () => {
    const entity: Entity = {
      name: 'Lena Ortiz',
      attributes: [
        { name: 'email', value: 'lena@example.com', identity: true },
        { name: 'phone', value: '555-010-0135', identity: true, shared: true },
        { name: 'phone', value: '555-010-0142', identity: true },
      ],
    };

    expect(legacyEntityIdentityKey(entity)).toBe('5550100135');
    expect(entityIdentityKey(entity)).toBe('5550100142');
  });

  it('agrees with entityIdentityKey for an entity nothing was marked on', () => {
    const entity: Entity = {
      attributes: [
        { name: 'phone', value: '555-010-0142' },
        { name: 'email', value: 'lena@example.com' },
      ],
    };

    expect(legacyEntityIdentityKey(entity)).toBe(entityIdentityKey(entity));
  });
});

describe('namesDescribeDifferentPeople', () => {
  it('is true for colleagues whose names share nothing', () => {
    expect(namesDescribeDifferentPeople('Priya Natarajan', 'Tom Becker')).toBe(true);
  });

  it('is false for the ways ONE person is filed twice', () => {
    // A nickname, a married name, a middle initial, a title, reversed order.
    expect(namesDescribeDifferentPeople('Matt Okafor', 'Matthew Okafor')).toBe(false);
    expect(namesDescribeDifferentPeople('Dana Reyes', 'Dana Whitfield')).toBe(false);
    expect(namesDescribeDifferentPeople('Ann Lee', 'Ann B. Lee')).toBe(false);
    expect(namesDescribeDifferentPeople('Dr. Omar Haddad', 'Omar Haddad PhD')).toBe(false);
    expect(namesDescribeDifferentPeople('Haddad, Omar', 'Omar Haddad')).toBe(false);
    expect(namesDescribeDifferentPeople('José Núñez', 'Jose Nunez')).toBe(false);
  });

  it('does not separate family members by a shared surname alone', () => {
    // Deliberately: the name cannot tell this from a typo or a nickname.
    expect(namesDescribeDifferentPeople('Ana Ruiz', 'Luis Ruiz')).toBe(false);
  });

  it('is never evidence for a missing name, a relation, or a handle in the name field', () => {
    expect(namesDescribeDifferentPeople('', 'Tom Becker')).toBe(false);
    expect(namesDescribeDifferentPeople(null, 'Tom Becker')).toBe(false);
    expect(namesDescribeDifferentPeople("Tom's mom", 'Grace Whitaker')).toBe(false);
    expect(namesDescribeDifferentPeople('tom@example.com', 'Grace Whitaker')).toBe(false);
    expect(namesDescribeDifferentPeople('(555) 010-0100', 'Grace Whitaker')).toBe(false);
  });

  it('does not count a connective like "de" or "and" as a shared name', () => {
    expect(namesDescribeDifferentPeople('Ines de Souza', 'Paul de Groot')).toBe(true);
    expect(namesDescribeDifferentPeople('Front Desk and Billing', 'Mia and Theo')).toBe(true);
  });
});

describe('markSharedContactHandles', () => {
  const phone = (value: string) => ({ name: 'phone', value, identity: true });
  const email = (value: string) => ({ name: 'email', value, identity: true });
  const sharedOf = (entity: Entity) =>
    (entity.attributes ?? []).filter((a) => a.shared).map((a) => normalizeHandle(a.value));

  // One office: a switchboard and a fax on every card, and each person's own
  // address. The shape that collapsed three colleagues into one Person.
  const office: Entity[] = [
    {
      name: 'Priya Natarajan',
      type: 'contact',
      attributes: [phone('555-010-0100'), phone('555-010-0101'), email('priya@example.com')],
    },
    {
      name: 'Tom Becker',
      type: 'contact',
      attributes: [phone('555-010-0101'), phone('555-010-0100'), email('tom@example.com')],
    },
    {
      name: 'Lena Ortiz',
      type: 'contact',
      attributes: [phone('555-010-0100'), email('lena@example.com'), phone('555-010-0142')],
    },
  ];

  it('keys every colleague apart when they share a switchboard and a fax', () => {
    // Before: every one of them keyed on 5550100100.
    expect(new Set(office.map(entityIdentityKey))).toEqual(new Set(['5550100100']));

    const marked = markSharedContactHandles(office, ['(555) 010-0101']);

    expect(marked.map(entityIdentityKey)).toEqual(['priya@example.com', 'tom@example.com', '5550100142']);
    expect(marked.map(sharedOf)).toEqual([
      ['5550100100', '5550100101'],
      ['5550100101', '5550100100'],
      ['5550100100'],
    ]);
  });

  it('keeps the legacy key where it was, so the old row can be found and moved', () => {
    const marked = markSharedContactHandles(office, ['(555) 010-0101']);

    expect(marked.map(legacyEntityIdentityKey)).toEqual(['5550100100', '5550100100', '5550100100']);
  });

  it('never keys anyone on a number the export types as a fax — even on a card that did not type it', () => {
    // One copy of a card typed the firm number FAX; the other left it untyped.
    // A per-card rule gave the copies two different keys and split one person.
    const copies: Entity[] = [
      { name: 'Omar Haddad', attributes: [phone('555-010-0150'), phone('555-010-0177')] },
      { name: 'Omar Haddad', attributes: [phone('555-010-0150'), phone('555-010-0177')] },
    ];

    const marked = markSharedContactHandles(copies, ['555-010-0150']);

    expect(marked.map(entityIdentityKey)).toEqual(['5550100177', '5550100177']);
  });

  it('leaves one person’s duplicate cards collapsing on the line they share', () => {
    const duplicates: Entity[] = [
      { name: 'Matt Okafor', attributes: [phone('555-010-0160'), email('matt@example.com')] },
      { name: 'Matthew Okafor', attributes: [phone('555-010-0160')] },
    ];

    const marked = markSharedContactHandles(duplicates);

    expect(marked.map(entityIdentityKey)).toEqual(['5550100160', '5550100160']);
    expect(marked[0]).toBe(duplicates[0]);
    expect(marked[1]).toBe(duplicates[1]);
  });

  it('takes no evidence from a nameless card', () => {
    const cards: Entity[] = [
      { name: 'Grace Whitaker', attributes: [phone('555-010-0170')] },
      { name: '', attributes: [phone('555-010-0170')] },
    ];

    expect(markSharedContactHandles(cards).map(entityIdentityKey)).toEqual(['5550100170', '5550100170']);
  });

  it('marks an email two different people list, not only a phone', () => {
    const cards: Entity[] = [
      { name: 'Priya Natarajan', attributes: [email('frontdesk@example.com'), phone('555-010-0102')] },
      { name: 'Tom Becker', attributes: [email('frontdesk@example.com')] },
    ];

    const marked = markSharedContactHandles(cards);

    expect(marked.map(entityIdentityKey)).toEqual(['5550100102', null]);
    expect(sharedOf(marked[1])).toEqual(['frontdesk@example.com']);
  });

  it('does not mutate what it was given', () => {
    const before = JSON.stringify(office);

    markSharedContactHandles(office, ['555-010-0101']);

    expect(JSON.stringify(office)).toBe(before);
  });
});

describe('isShortCode', () => {
  /*
   * The rule that keeps an SMS service out of somebody's address book. It has
   * to split TWO kinds of phone from each other without ever catching a name,
   * because the only caller that matters (googlevoice.ts participantType) uses
   * it to decide between `Person` and `Concept`.
   */
  it('accepts the three-to-six digit codes a real export carries', () => {
    // Every one of these is a name on the QA corpus's 142 mis-filed rows.
    for (const code of ['411', '2222', '32665', '99217', '227898', '+411']) {
      expect(isShortCode(code)).toBe(true);
    }
  });

  it('stops exactly where normalizeHandle starts keying, so there is no gap', () => {
    expect(isShortCode('123456')).toBe(true);
    expect(normalizeHandle('123456')).toBe('');

    expect(isShortCode('1234567')).toBe(false);
    expect(normalizeHandle('1234567')).toBe('1234567');
  });

  it('refuses a number a person can be reached on, however it is punctuated', () => {
    for (const phone of ['+15558887777', '555-888-7777', '(555) 888 7777', '+44 20 7946 0000']) {
      expect(isShortCode(phone)).toBe(false);
    }
  });

  it('refuses anything that is not a phone field at all', () => {
    // A name, a name carrying a digit, an email, and the empty/absent cases.
    // Without the phone-shape guard "Studio 54" would read as a short code.
    for (const value of ['Dana Wu', 'Studio 54', '411@example.invalid', '', '   ', undefined, null, 42]) {
      expect(isShortCode(value)).toBe(false);
    }
  });

  it('refuses phone punctuation carrying no number at all', () => {
    // Passes the shape test and normalizes to nothing, so only the digit count
    // separates it from a short code. A `tel:` href really can be junk.
    for (const value of ['+', '()', '- . -']) {
      expect(isShortCode(value)).toBe(false);
    }
  });
});

describe('resolveEntityType', () => {
  it('defaults a handle-carrying entity to contact when the parser omitted a type', () => {
    expect(resolveEntityType({ attributes: [{ name: 'email', value: 'a@b.com' }] })).toBe('contact');
  });

  it('never overrides a type the parser did set', () => {
    expect(
      resolveEntityType({ type: 'organization', attributes: [{ name: 'email', value: 'a@b.com' }] }),
    ).toBe('organization');
  });

  it('leaves the type of a handle-less entity alone, including when it is absent', () => {
    expect(resolveEntityType({ name: 'Paris' })).toBeNull();
    expect(hasContactIdentity({ name: 'Paris' })).toBe(false);
  });

  it('defaults a role-mailbox participant to organization instead of contact', () => {
    // gmail.ts's addParticipants stages exactly this shape: no `type`, one
    // `{name: 'from'|'to'|'cc', value, identity: true}` attribute — the kind
    // name carries no 'email'/'phone' signal, only `identity: true` does.
    const entity: Entity = {
      name: 'Support',
      attributes: [{ name: 'from', value: 'noreply@stripe.com', identity: true }],
    };

    expect(resolveEntityType(entity)).toBe(ORGANIZATIONAL_STAGED_TYPE);
  });

  it('keeps a mixed entity (a role mailbox found alongside a real phone) as contact', () => {
    const entity: Entity = {
      attributes: [
        { name: 'email', value: 'support@acme.example' },
        { name: 'phone', value: '+1 555 010 9999' },
      ],
    };

    expect(resolveEntityType(entity)).toBe('contact');
  });
});

describe('isOrganizationalAddress', () => {
  it('flags role local-parts at any domain', () => {
    for (const address of ['noreply@stripe.com', 'support@acme.example', 'billing+receipts@shop.example']) {
      expect(isOrganizationalAddress(address)).toBe(true);
    }
  });

  it('flags an address on a non-routable/internal TLD', () => {
    expect(isOrganizationalAddress('server-42@build.internal')).toBe(true);
  });

  it('leaves a real person addressed at any domain alone', () => {
    for (const address of ['alice@example.com', 'a@b.com', 'jose.garcia@somecompany.example']) {
      expect(isOrganizationalAddress(address)).toBe(false);
    }
  });

  it('is false for a value with no @ at all', () => {
    expect(isOrganizationalAddress('not-an-email')).toBe(false);
  });
});

describe('contactIdentifiers — every method a contact states as its own', () => {
  // Invented: the 555-01XX fiction range, and `.example` mail domains.
  const card = (attributes: Entity['attributes'], type = 'contact'): Entity => ({
    name: 'Ada Quill',
    type,
    attributes,
  });

  it('keeps every email and phone, not just the one handle the natural key takes', () => {
    // Digits sort before letters: the key is the phone, and before this the
    // email was never indexed at all.
    const entity = card([
      { name: 'phone', value: '(202) 555-0142', identity: true },
      { name: 'phone', value: '+1 212 555 0199', identity: true },
      { name: 'email', value: 'Ada.Quill@Example.com', identity: true },
    ]);

    expect(entityIdentityKey(entity)).toBe('2025550142');
    expect(contactIdentifiers(entity)).toEqual({
      emails: ['ada.quill@example.com'],
      phones: ['2025550142', '2125550199'],
    });
  });

  it('leaves out a fax, an extension number, a role inbox and a value that is not a number', () => {
    const entity = card([
      { name: 'phone', value: '(212) 555-0110;229', identity: true },
      { name: 'phone', value: '(212) 555-0110 x12', identity: true },
      { name: FAX_ATTRIBUTE_NAME, value: '(212) 555-0118', identity: true },
      { name: 'phone', value: 'Office: 212 555 0111', identity: true },
      { name: 'email', value: 'info@quill-legal.example', identity: true },
      { name: 'email', value: 'ada@quill-legal.example', identity: true },
    ]);

    expect(contactIdentifiers(entity)).toEqual({ emails: ['ada@quill-legal.example'], phones: [] });
    // Every one of them still counts toward the natural key, which must never
    // move — here the "Office:" value's digits sort smallest.
    expect(entityIdentityKey(entity)).toBe('2125550111');
  });

  it('reads URI and display forms the way the identity index does', () => {
    const entity = card([
      { name: 'phone', value: 'tel:+1-202-555-0142', identity: true },
      { name: 'email', value: 'mailto:ada@example.com', identity: true },
      { name: 'email', value: 'Ada Quill <ADA@example.com>', identity: true },
    ]);

    expect(contactIdentifiers(entity)).toEqual({ emails: ['ada@example.com'], phones: ['2025550142'] });
  });

  it('is empty for anything that does not become a Person', () => {
    const place = card([{ name: 'phone', value: '(202) 555-0142' }], 'place');

    expect(contactIdentifiers(place)).toEqual({ emails: [], phones: [] });
    expect(withContactIdentifiers(place)).toBe(place);
  });

  it('records both lists on a Person, empty ones included, and makes them accumulate', () => {
    // An empty `phones` is information: this contact states no line of its
    // own, so its handle (a fax, here) must not be indexed as one.
    const faxOnly = card([{ name: FAX_ATTRIBUTE_NAME, value: '(212) 555-0118', identity: true }]);
    const staged = withContactIdentifiers({ ...faxOnly, accumulate: ['Names'] });

    expect(staged.metadata).toEqual({ emails: [], phones: [], [CONTACT_NAMES_KEY]: ['Ada Quill'] });
    expect(staged.accumulate).toEqual(['Names', ...CONTACT_IDENTIFIER_KEYS, CONTACT_NAMES_KEY]);
    expect(entityIdentityKey(staged)).toBe(entityIdentityKey(faxOnly));
  });

  it('grows a repeat sighting by what it adds', () => {
    const first = withContactIdentifiers(card([{ name: 'phone', value: '(202) 555-0142', identity: true }]));
    const second = withContactIdentifiers(
      card([
        { name: 'phone', value: '202.555.0142', identity: true },
        { name: 'email', value: 'ada@example.com', identity: true },
      ]),
    );

    expect(mergeAccumulatedMetadata(first.metadata as Record<string, unknown>, second)).toEqual({
      emails: ['ada@example.com'],
      phones: ['2025550142'],
      [CONTACT_NAMES_KEY]: ['Ada Quill'],
    });
  });

  it("records every sighting's name, so the push can see a row that is two people", () => {
    // A household on one home line: #2795 keeps them together, and staging
    // collapses them onto one row that only knows the first sighting's name.
    const ana = withContactIdentifiers({
      ...card([
        { name: 'phone', value: '(415) 555-0100', identity: true },
        { name: 'email', value: 'ana.ruiz@example.com', identity: true },
      ]),
      name: 'Ana Ruiz',
    });
    const luis = withContactIdentifiers({
      ...card([
        { name: 'phone', value: '(415) 555-0100', identity: true },
        { name: 'email', value: 'luis.ruiz@example.org', identity: true },
      ]),
      name: 'Luis Ruiz',
    });

    expect(entityIdentityKey(ana)).toBe(entityIdentityKey(luis));
    expect(mergeAccumulatedMetadata(ana.metadata as Record<string, unknown>, luis)).toMatchObject({
      emails: ['ana.ruiz@example.com', 'luis.ruiz@example.org'],
      [CONTACT_NAMES_KEY]: ['Ana Ruiz', 'Luis Ruiz'],
    });
  });

  it('reads each value of a Google CSV cell that joins them with :::', () => {
    const entity = card([
      { name: 'email', value: 'ada@example.com ::: Ada.Q@Example.org', identity: true },
      { name: 'phone', value: '+1 202-555-0142 ::: +1 202-555-0177', identity: true },
    ]);

    expect(contactIdentifiers(entity)).toEqual({
      emails: ['ada@example.com', 'ada.q@example.org'],
      phones: ['2025550142', '2025550177'],
    });
  });
});

describe('hashItem', () => {
  const photo = (folder: string): Item => ({
    classification: 'photo',
    timestamp: new Date('2012-07-04T10:00:00Z'),
    content: { filename: 'IMAG0262.jpg' },
    intermediateLocation: folder,
  });

  it('collapses one photo replicated across album folders — the Takeout case', () => {
    // The path is deliberately NOT hashed. With it, this file staged three times
    // and reached the server as three events.
    expect(hashItem(photo('European Vacation/'), 'google_photos')).toBe(
      hashItem(photo('Photos from 2012/'), 'google_photos'),
    );
  });

  it('keeps genuinely different content apart', () => {
    const base = photo('Album/');
    const renamed: Item = { ...base, content: { filename: 'IMAG0263.jpg' } };
    const later: Item = { ...base, timestamp: new Date('2012-07-05T10:00:00Z') };

    expect(hashItem(renamed, 'google_photos')).not.toBe(hashItem(base, 'google_photos'));
    expect(hashItem(later, 'google_photos')).not.toBe(hashItem(base, 'google_photos'));
  });

  it('separates the same file arriving from two sources', () => {
    expect(hashItem(photo('Album/'), 'google_photos')).not.toBe(hashItem(photo('Album/'), 'icloud'));
  });

  it('prefers the parser own id when it has one', () => {
    expect(hashItem({ id: 'gmail-msg-1', classification: 'email' }, 'gmail')).toBe('gmail-msg-1');
  });

  it('distinguishes items by coordinates when nothing else differs', () => {
    const here: Item = { classification: 'visit', location: { latitude: 1, longitude: 2 } };
    const there: Item = { classification: 'visit', location: { latitude: 3, longitude: 4 } };

    expect(hashItem(here, 'google_location')).not.toBe(hashItem(there, 'google_location'));
  });

  /**
   * The degenerate fallback — no parser id, no timestamp, no coordinates —
   * which is not an edge case: 79,906 of 80,067 `generic` rows in a real 462k
   * run carried no timestamp, and 24 parsers assign no id at all.
   *
   * Reproduced live before the fix: `AliceThread/note.txt` (25 bytes) and
   * `BobThread/note.txt` (29 bytes) in one unit staged as ONE row. The 29-byte
   * file was consumed by the unpack's rename and deleted with the run's scratch
   * tree, leaving no record of it anywhere but an `itemsDeduped` tick.
   */
  describe('when the item has neither a timestamp nor coordinates', () => {
    const note = (folder: string): Item => ({
      classification: 'note',
      content: { filename: 'note.txt' },
      intermediateLocation: `${folder}/note.txt`,
    });

    it('keeps two same-named files in different folders apart', () => {
      expect(hashItem(note('AliceThread'), 'generic')).not.toBe(hashItem(note('BobThread'), 'generic'));
    });

    it('prefers the content digest, so identical bytes still collapse across folders', () => {
      // The album-replication guarantee, preserved for items that have no
      // timestamp to collapse on: same bytes, two paths, one staged row.
      expect(hashItem(note('European Vacation'), 'google_photos', 'deadbeef')).toBe(
        hashItem(note('Photos from 2012'), 'google_photos', 'deadbeef'),
      );
    });

    it('separates different bytes at the same path', () => {
      expect(hashItem(note('Thread'), 'generic', 'aaaa')).not.toBe(
        hashItem(note('Thread'), 'generic', 'bbbb'),
      );
    });

    it('falls back to the metadata for a record that carries no file at all', () => {
      const record = (body: string): Item => ({ classification: 'note', metadata: { body } });

      expect(hashItem(record('one'), 'generic')).not.toBe(hashItem(record('two'), 'generic'));
    });
  });

  it('leaves the hash of every non-degenerate item exactly as it was', () => {
    // The fold-in must not reach items that already key on something real, or
    // an in-flight run's staged rows would stop matching their own dedup index.
    const dated: Item = {
      classification: 'photo',
      timestamp: new Date('2012-07-04T10:00:00Z'),
      content: { filename: 'IMAG0262.jpg' },
      intermediateLocation: 'European Vacation/IMAG0262.jpg',
    };
    const elsewhere: Item = { ...dated, intermediateLocation: 'Photos from 2012/IMAG0262.jpg' };

    expect(hashItem(dated, 'google_photos', 'aaaa')).toBe(hashItem(elsewhere, 'google_photos', 'bbbb'));
  });
});

describe('needsContentDigest', () => {
  it('is true only when nothing else identifies the item', () => {
    expect(needsContentDigest({ classification: 'note', content: { filename: 'note.txt' } })).toBe(true);
  });

  it('is false as soon as a parser id, a timestamp or a location is present', () => {
    expect(needsContentDigest({ id: 'gmail-1' })).toBe(false);
    expect(needsContentDigest({ timestamp: new Date('2012-07-04T10:00:00Z') })).toBe(false);
    expect(needsContentDigest({ location: { latitude: 1, longitude: 2 } })).toBe(false);
  });

  it('is true for an unparseable timestamp, which identifies nothing', () => {
    expect(needsContentDigest({ timestamp: new Date('not a date') })).toBe(true);
  });
});

describe('entityKey', () => {
  it('collapses display-name drift for one handle', () => {
    const short: Entity = { name: 'Alice', attributes: [{ name: 'email', value: 'a@b.com' }] };
    const long: Entity = { name: 'Alice Smith', attributes: [{ name: 'email', value: 'a@b.com' }] };

    expect(entityKey(short)).toBe(entityKey(long));
  });

  it('collapses a type-less contact onto its freshly-defaulted counterpart', () => {
    const untyped: Entity = { name: 'Thread A' };
    const typed: Entity = { type: null as unknown as string, name: 'Thread A' };

    expect(entityKey(untyped)).toBe(entityKey(typed));
  });

  it('keeps two handle-less entities with different names apart', () => {
    expect(entityKey({ name: 'Paris' })).not.toBe(entityKey({ name: 'Berlin' }));
  });
});

describe('mergeAccumulatedMetadata', () => {
  const dish: Entity = {
    name: 'Burger',
    accumulate: ['prices'],
    metadata: { prices: ['15.92'] },
  };

  it('appends a genuinely new value to what is already stored', () => {
    const merged = mergeAccumulatedMetadata({ prices: ['10.19'] }, dish);

    // Both are true — January and March — and the useful record is the set.
    expect(merged).toEqual({ prices: ['10.19', '15.92'] });
  });

  it('returns null when the sighting adds nothing, so nothing is written', () => {
    expect(mergeAccumulatedMetadata({ prices: ['15.92'] }, dish)).toBeNull();
  });

  it('leaves undeclared keys exactly as stored', () => {
    const merged = mergeAccumulatedMetadata({ prices: ['10.19'], name: 'Cheeseburger' }, dish);

    expect(merged?.name).toBe('Cheeseburger');
  });

  it('compares objects by content regardless of key order', () => {
    const order: Entity = {
      accumulate: ['orders'],
      metadata: { orders: [{ qty: 1, item: 'fries' }] },
    };

    expect(mergeAccumulatedMetadata({ orders: [{ item: 'fries', qty: 1 }] }, order)).toBeNull();
  });

  it('does nothing for an entity that declared no accumulating keys', () => {
    expect(mergeAccumulatedMetadata({ prices: ['1'] }, { metadata: { prices: ['2'] } })).toBeNull();
  });
});
