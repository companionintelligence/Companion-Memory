import type { StagedEntity } from '../../entities/StagedEntityEntity';
import {
  contactMethodsFor,
  describesSeveralPeople,
  entityTypeFor,
  isGraphExcluded,
  naturalKeyFor,
  toGraphEntity,
} from '../entities';

/**
 * The entity lane, tested at the mapper.
 *
 * The bug this replaces was not subtle — the normalized handle was passed as
 * `linkedId`, which is a `uuid` column, so every entity carrying a handle died
 * on "invalid input syntax for type uuid" and every entity without one was
 * skipped for want of a key. Nothing resolved, `entity_mappings` stayed empty,
 * and a real Amazon import dropped all 613 of its item→entity edges.
 *
 * It survived review because the only test was a unit test whose mocked
 * `PersonService` accepted whatever the mapper produced. So these assertions are
 * about the SHAPE handed to the server, and the integration spec alongside them
 * is about what a real database does with it.
 */
function staged(overrides: Partial<StagedEntity> = {}): StagedEntity {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    runId: '22222222-2222-2222-2222-222222222222',
    userId: '33333333-3333-3333-3333-333333333333',
    type: 'contact',
    name: 'Alice Smith',
    metadata: {},
    identityKey: 'alice@example.com',
    dataSource: 'gmail',
    graphDirty: false,
    pushStatus: 'pending',
    pushError: null,
    pushedAt: null,
    createdAt: new Date(),
    ...overrides,
  } as StagedEntity;
}

describe('naturalKeyFor', () => {
  it('prefers the handle, because display names drift between sources', () => {
    const key = naturalKeyFor(staged({ name: 'Alice' }));

    expect(key).toBe(naturalKeyFor(staged({ name: 'Alice Smith' })));
    expect(key).toContain('alice@example.com');
  });

  it('falls back to the name for the things that have no handle by nature', () => {
    // Artists, genres and dishes are most of what a media archive stages. The
    // old lane skipped every one of them.
    expect(naturalKeyFor(staged({ type: 'person', name: 'Foghat', identityKey: null }))).toBe(
      'person:foghat',
    );
  });

  it('is case-insensitive on the name, so one artist is not two', () => {
    expect(naturalKeyFor(staged({ name: 'FOGHAT', identityKey: null }))).toBe(
      naturalKeyFor(staged({ name: 'foghat', identityKey: null })),
    );
  });

  it('keeps types apart, so a restaurant and its dish cannot collide on a name', () => {
    expect(naturalKeyFor(staged({ type: 'food', name: 'Napoli', identityKey: null }))).not.toBe(
      naturalKeyFor(staged({ type: 'place', name: 'Napoli', identityKey: null })),
    );
  });

  it('gives up only when there is neither handle nor name', () => {
    expect(naturalKeyFor(staged({ name: null, identityKey: null }))).toBeNull();
    expect(naturalKeyFor(staged({ name: '   ', identityKey: null }))).toBeNull();
  });
});

describe('isGraphExcluded', () => {
  it('keeps email_thread out of the graph', () => {
    // gmail.ts emits one per message carrying the raw Message-ID as its name.
    // Without this gate they fall through to Concept, and because the explorer
    // never type-filters connective types away and orders newest-first, the
    // Concept slice of the canvas becomes Message-ID strings with degree 0 —
    // one per email imported. Upstream measured ≈148k of them.
    expect(isGraphExcluded(staged({ type: 'email_thread' }))).toBe(true);
    expect(isGraphExcluded(staged({ type: 'EMAIL_THREAD' }))).toBe(true);
  });

  it('lets everything else through', () => {
    for (const type of ['contact', 'person', 'place', 'music_genre', 'whatever-a-csv-said']) {
      expect(isGraphExcluded(staged({ type }))).toBe(false);
    }
  });
});

describe('entityTypeFor', () => {
  it.each([
    ['contact', 'Person'],
    ['person', 'Person'],
    ['place', 'Location'],
    ['music_genre', 'Concept'],
  ])('files a %s as a %s', (type, expected) => {
    expect(entityTypeFor(staged({ type }))).toBe(expected);
  });

  it('files an unknown parser type as a Concept rather than refusing it', () => {
    // One parser reads its type straight out of a CSV column, so the set is not
    // closed and an unrecognised value must not cost the entity its row.
    expect(entityTypeFor(staged({ type: 'something_a_csv_said' }))).toBe('Concept');
  });
});

describe('toGraphEntity — staging bookkeeping', () => {
  it("never writes the sightings' names into the Person's properties", () => {
    const input = toGraphEntity({
      type: 'contact',
      identityKey: '4155550100',
      name: 'Ana Ruiz',
      dataSource: 'vcard',
      metadata: { phones: ['4155550100'], emails: [], contactNames: ['Ana Ruiz'] },
    } as never);

    expect(input?.properties).not.toHaveProperty('contactNames');
    expect(input?.properties).toMatchObject({ phones: ['4155550100'], phone: '4155550100' });
  });
});

describe('toGraphEntity', () => {
  it('never puts a handle where a uuid belongs', () => {
    // The whole bug in one assertion: the identity travels as a natural KEY,
    // which GraphIngestService hashes into linked_id itself.
    const input = toGraphEntity(staged());

    expect(input).not.toBeNull();
    expect(input).not.toHaveProperty('linkedId');
    expect(input?.key).toContain('alice@example.com');
  });

  it('carries the email where GraphIngestService looks for identifiers', () => {
    // `emails`/`phones` are what populate ci.entity_identifiers — the index that
    // later matches this person to the same person in another export.
    const input = toGraphEntity(staged());

    expect(input?.properties).toMatchObject({
      email: 'alice@example.com',
      emails: ['alice@example.com'],
      names: ['Alice Smith'],
    });
  });

  it('routes a phone handle to phones, not emails', () => {
    const input = toGraphEntity(staged({ identityKey: '9145820196' }));

    expect(input?.properties).toMatchObject({ phone: '9145820196', phones: ['9145820196'] });
    expect(input?.properties).not.toHaveProperty('emails');
  });

  it('attributes the entity to the parser that produced it', () => {
    // sourceSystem is part of the server-side identity, so a missing one must be
    // a stable string rather than undefined.
    expect(toGraphEntity(staged({ dataSource: 'amazon_music' }))?.sourceSystem).toBe('amazon_music');
    expect(toGraphEntity(staged({ dataSource: null }))?.sourceSystem).toBe('unknown');
  });

  it('preserves the parser metadata it was staged with', () => {
    const input = toGraphEntity(staged({ metadata: { ASIN: 'B000QJJSW6', Source: 'Amazon Music' } }));

    expect(input?.properties).toMatchObject({ ASIN: 'B000QJJSW6', Source: 'Amazon Music' });
  });

  it('resolves a handle-less artist instead of dropping it', () => {
    const input = toGraphEntity(staged({ type: 'person', name: 'Foghat', identityKey: null }));

    expect(input).toMatchObject({ key: 'person:foghat', entityType: 'Person', name: 'Foghat' });
  });

  it('returns null only for an entity with nothing to key on', () => {
    expect(toGraphEntity(staged({ name: null, identityKey: null }))).toBeNull();
  });

  it('indexes every email and phone staging recorded, not only the key', () => {
    // A contact keyed on its phone used to reach ci.entity_identifiers with
    // that one number: its email never did, so mail from it minted a stub.
    const input = toGraphEntity(
      staged({
        identityKey: '2025550142',
        metadata: { emails: ['ada@example.com'], phones: ['2125550199', '2025550142'] },
      }),
    );

    expect(input?.key).toBe('contact:2025550142');
    expect(input?.properties).toMatchObject({
      email: 'ada@example.com',
      emails: ['ada@example.com'],
      phone: '2025550142',
      phones: ['2025550142', '2125550199'],
    });
  });

  it('keys on a fax or an extension handle but never indexes it as a line', () => {
    // Staging recorded the contact's own numbers and the handle is not one of
    // them: it is the office fax (or a number with an extension).
    const input = toGraphEntity(staged({ identityKey: '2125550118', metadata: { emails: [], phones: [] } }));

    expect(input?.key).toBe('contact:2125550118');
    expect(input?.properties).not.toHaveProperty('phone');
    expect(input?.properties).not.toHaveProperty('phones');
    expect(input?.properties).not.toHaveProperty('emails');
  });
});

describe('contactMethodsFor', () => {
  it('puts the handle first when it is one of the contact’s own', () => {
    expect(contactMethodsFor({ emails: ['bo@example.com', 'ada@example.com'] }, 'ada@example.com')).toEqual({
      emails: ['ada@example.com', 'bo@example.com'],
      phones: [],
    });
  });

  it('keeps a row staged before the lists existed exactly as it was: its handle is its identifier', () => {
    expect(contactMethodsFor({ Source: 'vCard' }, '2025550142')).toEqual({
      emails: [],
      phones: ['2025550142'],
    });
  });

  it('always keeps an email handle, even one staging would not record', () => {
    // A role-mailbox contact is nothing but its address.
    expect(contactMethodsFor({ emails: [], phones: [] }, 'support@acme.example')).toEqual({
      emails: ['support@acme.example'],
      phones: [],
    });
  });

  // Invented: a household on one home line, collapsed by staging onto one row.
  const household = {
    emails: ['ana.ruiz@example.com', 'luis.ruiz@example.org'],
    phones: ['4155550100', '4155550111', '4155550122'],
  };

  it("indexes a row that is several people on its handle alone — never one member's address as another's", () => {
    expect(
      contactMethodsFor({ ...household, contactNames: ['Ana Ruiz', 'Luis Ruiz'] }, '4155550100'),
    ).toEqual({
      emails: [],
      phones: ['4155550100'],
    });
  });

  it("reads the vCard parser's Names for a row staged before the sightings' names were kept", () => {
    expect(contactMethodsFor({ ...household, Names: ['Ana Ruiz', 'Luis Ruiz'] }, '4155550100')).toEqual({
      emails: [],
      phones: ['4155550100'],
    });
  });

  it('keeps every method of one person seen under two spellings', () => {
    expect(
      contactMethodsFor({ ...household, contactNames: ['Ana Ruiz', 'Ana M. Ruiz'] }, '4155550100'),
    ).toEqual(household);
  });
});

describe('describesSeveralPeople', () => {
  it('is false for one name, or one person under several spellings', () => {
    expect(describesSeveralPeople([])).toBe(false);
    expect(describesSeveralPeople(['Ana Ruiz'])).toBe(false);
    expect(describesSeveralPeople(['Ana Ruiz', 'Ana Ruiz ', 'A. Ruiz', 'Ana M Ruiz'])).toBe(false);
    // A nickname prefix.
    expect(describesSeveralPeople(['Dani Ruiz', 'Danielle Ruiz'])).toBe(false);
  });

  it('is true for two first names, a Jr/Sr pair, or a placeholder among names', () => {
    expect(describesSeveralPeople(['Ana Ruiz', 'Luis Ruiz'])).toBe(true);
    expect(describesSeveralPeople(['Luis Ruiz Sr.', 'Luis Ruiz Jr.'])).toBe(true);
    // A card named with a number says nothing about who it is.
    expect(describesSeveralPeople(['Ana Ruiz', '(415) 555-0100'])).toBe(true);
    expect(describesSeveralPeople(['Ana Ruiz', 'luis.ruiz@example.org'])).toBe(true);
  });
});

describe('a Person is never named with a parser leak', () => {
  // 2,353 live Person rows reached ci.entities through THIS function named
  // "Missed call from" / "Placed call to\nJudy Collins" — the display name a
  // user actually reads, minted from staged.name without a single check.
  it('falls back to the handle when the staged name is a call-log heading', () => {
    const dto = toGraphEntity(
      staged({
        type: 'contact',
        name: 'Missed call from',
        identityKey: '4155550100',
        dataSource: 'google_voice',
      }),
    );

    expect(dto?.name).toBe('4155550100');
    expect(dto?.properties?.names).toBeUndefined();
    expect(dto?.properties?.phones).toEqual(['4155550100']);
  });

  it('does the same for an export filename and for a name carrying a newline', () => {
    const filename = toGraphEntity(
      staged({ name: 'Group Conversation - 2024-09-25T01_45_41Z.html', identityKey: '4155550100' }),
    );
    expect(filename?.name).toBe('4155550100');
    expect(filename?.properties?.names).toBeUndefined();

    const newline = toGraphEntity(
      staged({ name: 'Placed call to \nJudy Collins', identityKey: '4155550100' }),
    );
    expect(newline?.name).toBe('4155550100');
    expect(newline?.properties?.names).toBeUndefined();
  });

  it('leaves a real name exactly as it was', () => {
    const dto = toGraphEntity(staged({ name: 'Judy Collins', identityKey: '4155550100' }));

    expect(dto?.name).toBe('Judy Collins');
    expect(dto?.properties?.names).toEqual(['Judy Collins']);
  });

  it('does not apply the rule to non-Person types — a Concept may be named after a file', () => {
    const dto = toGraphEntity(staged({ type: 'document', name: 'invoice.pdf', identityKey: null }));

    expect(dto?.entityType).toBe('Concept');
    expect(dto?.name).toBe('invoice.pdf');
    expect(dto?.properties?.names).toEqual(['invoice.pdf']);
  });

  it('leaves the Person NAMELESS when there is no handle to fall back to', () => {
    // The entity survives — dropping it would silently delete an edge endpoint —
    // but it is not named after the leak. Withholding `properties.names` and
    // then showing the same string as the display name was the worst of both:
    // the People view read "Missed call from" while the identifier index, which
    // is what would let a later import find this contact again, held nothing.
    // `ci.entities.name` is nullable and GraphIngestService writes
    // `input.name ?? null` straight through, so null is a representable answer.
    const dto = toGraphEntity(staged({ name: 'Missed call from', identityKey: null }));

    expect(dto).not.toBeNull();
    expect(dto?.name).toBeNull();
    expect(dto?.properties?.names).toBeUndefined();
  });

  it('still keys on the staged name, so refusing to SHOW it moves no natural key', () => {
    // The display name and the identity are different questions. `naturalKeyFor`
    // reads `staged.name`, GraphIngestService derives linked_id from that key,
    // and the ingest coordinate is the idempotency anchor — so a row whose name
    // this function refuses must still resolve to the row a previous import
    // created, or every run mints another one.
    const dto = toGraphEntity(staged({ name: 'Missed call from', identityKey: null }));

    expect(dto?.key).toBe(naturalKeyFor(staged({ name: 'Missed call from', identityKey: null })));
    expect(dto?.key).toBe('contact:missed call from');
  });
});

describe('a Person is never named with a placeholder', () => {
  it('falls back to the handle for a vCard that carried no name at all', () => {
    // 139 live Person rows are exactly this: `vcard.ts` computes
    // `const name = fn || structuredName` — the empty string when a card has
    // neither — and `'' ?? handle` is `''`, because `??` does not catch it. The
    // address was in properties.email the whole time.
    const dto = toGraphEntity(staged({ name: '', identityKey: 'wallon@3data.io' }));

    expect(dto?.name).toBe('wallon@3data.io');
    expect(dto?.properties?.names).toBeUndefined();
  });

  it('does the same for a whitespace-only and a punctuation-only name', () => {
    expect(toGraphEntity(staged({ name: '   ', identityKey: 'alice@example.com' }))?.name).toBe(
      'alice@example.com',
    );
    expect(toGraphEntity(staged({ name: '?', identityKey: '4155550100' }))?.name).toBe('4155550100');
  });

  it('refuses a generic label the identifier index would turn into an attractor', () => {
    // ci.entity_identifiers is UNIQUE on (owner, kind, value_normalized), so one
    // `name` row for "Unknown" belongs to ONE Person and every later participant
    // called "Unknown" resolves to them.
    const dto = toGraphEntity(staged({ name: '(Unknown)', identityKey: '4155550100' }));

    expect(dto?.name).toBe('4155550100');
    expect(dto?.properties?.names).toBeUndefined();
  });

  it('keeps a real name that merely LOOKS decorated', () => {
    // Most of a LinkedIn export: an emoji or a credential hung off a real name.
    // The predicate asks whether there is a letter anywhere, not whether the
    // string is tidy.
    for (const name of ['🚀 Russell Levine', 'Alex Terrazas, Ph.D.', '田中', 'Na', 'Nil']) {
      const dto = toGraphEntity(staged({ name, identityKey: 'alice@example.com' }));

      expect(dto?.name).toBe(name);
      expect(dto?.properties?.names).toEqual([name]);
    }
  });

  it('does not apply the rule to non-Person types', () => {
    // A Concept named "Unknown" is a thing an export really did contain, and it
    // claims no identifier index.
    const dto = toGraphEntity(staged({ type: 'music_genre', name: 'Unknown', identityKey: null }));

    expect(dto?.entityType).toBe('Concept');
    expect(dto?.name).toBe('Unknown');
    expect(dto?.properties?.names).toEqual(['Unknown']);
  });

  it('trims the display name it does keep', () => {
    // properties.names has always been trimmed; the display name was not, so the
    // two disagreed about what this person is called.
    const dto = toGraphEntity(staged({ name: '  Judy Collins  ', identityKey: '4155550100' }));

    expect(dto?.name).toBe('Judy Collins');
    expect(dto?.properties?.names).toEqual(['Judy Collins']);
  });
});
