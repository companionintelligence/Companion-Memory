import type { PersonIdentifierType } from '../types/PersonIdentifierType';

import {
  contactMethodsFromPersonProperties,
  contactsToReconcile,
  droppedContactsPatch,
  mergePersonIdentifiers,
  removedContactPatch,
} from './personContactMethods';

describe('contactMethodsFromPersonProperties', () => {
  it('reads the named email field that egress strips out of properties', () => {
    expect(
      contactMethodsFromPersonProperties({
        email: 'chamberlain.bennett@gmail.com',
        properties: {},
      }),
    ).toEqual([
      expect.objectContaining({
        kind: 'email',
        value: 'chamberlain.bennett@gmail.com',
        rawValue: 'chamberlain.bennett@gmail.com',
        source: 'properties',
      }),
    ]);
  });

  it('reads emails[] and phones[] arrays, including Google Contacts {value,type} objects', () => {
    const contacts = contactMethodsFromPersonProperties({
      properties: {
        emails: [{ value: 'John.Bennett@Example.com', type: 'work' }, 'john@home.example'],
        phones: [{ value: '+1 (415) 555-0100', type: 'mobile' }],
      },
    });

    expect(contacts).toEqual([
      expect.objectContaining({ kind: 'email', value: 'john.bennett@example.com', label: 'work' }),
      expect.objectContaining({ kind: 'email', value: 'john@home.example' }),
      expect.objectContaining({ kind: 'phone', value: '4155550100', label: 'mobile' }),
    ]);
  });

  it('dedupes the same mailbox written as both email and emails[]', () => {
    const contacts = contactMethodsFromPersonProperties({
      email: 'dana@example.com',
      properties: { emails: ['dana@example.com', 'DANA@example.com'] },
    });

    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.value).toBe('dana@example.com');
  });
});

describe('mergePersonIdentifiers', () => {
  it('keeps the indexed row and fills property-only contacts', () => {
    const indexed: PersonIdentifierType[] = [
      {
        kind: 'email',
        value: 'dana@example.com',
        rawValue: 'dana@example.com',
        label: 'home',
        isPrimary: true,
        source: 'user',
        verifiedAt: null,
      },
    ];
    const fromProperties: PersonIdentifierType[] = [
      {
        kind: 'email',
        value: 'dana@example.com',
        rawValue: 'dana@example.com',
        label: null,
        isPrimary: false,
        source: 'properties',
        verifiedAt: null,
      },
      {
        kind: 'phone',
        value: '4155550100',
        rawValue: '+1 (415) 555-0100',
        label: null,
        isPrimary: false,
        source: 'properties',
        verifiedAt: null,
      },
    ];

    const merged = mergePersonIdentifiers(indexed, fromProperties);

    expect(merged).toHaveLength(2);
    expect(merged[0]?.source).toBe('user');
    expect(merged[1]?.kind).toBe('phone');
  });
});

/** What a save leaves on the row: the stored person with the patch applied, as `properties || patch` does. */
function applied(
  person: { email?: string | null; properties?: Record<string, unknown> },
  patch: Record<string, unknown>,
) {
  const { email: patchedEmail, ...rest } = patch;

  return {
    email: 'email' in patch ? (patchedEmail as string | null) : person.email,
    properties: { ...person.properties, ...rest },
  };
}

describe('droppedContactsPatch', () => {
  it('drops the copies of a contact the form no longer sends, comparing by join key', () => {
    const person = {
      properties: {
        emails: ['dana@example.test', 'dana.work@example.test'],
        phones: ['(555) 010-0142', '(555) 010-0143'],
      },
    };

    const patch = droppedContactsPatch(person, [
      { kind: 'email', value: 'Dana@Example.test' },
      // Another spelling of the number that is kept.
      { kind: 'phone', value: '555.010.0142' },
    ]);

    expect(patch).toEqual({ emails: ['dana@example.test'], phones: ['(555) 010-0142'] });
  });

  it('returns nothing to write when the form sends back everything it showed', () => {
    const person = { email: 'dana@example.test', properties: { phones: ['(555) 010-0142'] } };

    const shown = contactMethodsFromPersonProperties(person).map((row) => ({
      kind: row.kind as 'email' | 'phone',
      value: row.rawValue ?? row.value,
    }));

    expect(droppedContactsPatch(person, shown)).toEqual({});
  });

  it('keeps the entries it keeps exactly as stored, labelled objects included', () => {
    const work = { value: 'Lee@Example.test', type: 'work' };
    const home = { value: 'lee@home.example.test', type: 'home' };

    const patch = droppedContactsPatch({ properties: { emails: [work, home] } }, [
      { kind: 'email', value: 'lee@example.test' },
    ]);

    expect(patch).toEqual({ emails: [work] });
    expect((patch.emails as unknown[])[0]).toBe(work);
  });

  it('clears the email the egress surfaces as a field, and leaves an emptied list a list', () => {
    const patch = droppedContactsPatch(
      // Egress strips `email` from the bag; the stored key is still `email`.
      {
        email: 'dana@example.test',
        properties: { emails: ['dana@example.test'], phone: '5550100142', phones: ['5550100142'] },
      },
      [],
    );

    // Never a JSON null for a list: SQL readers pass it to jsonb_array_elements.
    expect(patch).toEqual({ email: null, emails: [], phone: null, phones: [] });
  });

  it('leaves alone a stored value the form never showed', () => {
    const patch = droppedContactsPatch({ properties: { phones: ['n/a', '(555) 010-0147'] } }, []);

    expect(patch).toEqual({ phones: ['n/a'] });
  });

  it("never edits an import's typed record of the contact card", () => {
    const patch = droppedContactsPatch(
      {
        properties: {
          Names: ['Lee Example'],
          Emails: ['lee@example.test'],
          Phones: ['(555) 010-0144'],
          Faxes: ['(555) 010-0145'],
          phone: '5550100144',
          phones: ['5550100144'],
        },
      },
      [],
    );

    expect(patch).toEqual({ phone: null, phones: [] });
  });

  // The tripwire for the ownership split. Every key the Details card reads a
  // contact from has to be removable here, because the form cannot remove a
  // row any other way. If this fails after contactMethodsFromPersonProperties
  // starts reading a new key — a card's typed `Emails`/`Phones`, say — that key
  // needs its own removal story: this patch deliberately never edits an
  // import's record, so either refuse such a removal before anything is
  // written, or record it somewhere the display honours.
  it('can remove every contact the Details card shows', () => {
    const person = {
      email: 'dana@example.test',
      properties: {
        emails: ['dana.work@example.test', { value: 'dana@home.example.test', type: 'home' }],
        phone: '(555) 010-0142',
        phones: ['(555) 010-0143', { value: '+1 555 010 0144', type: 'mobile' }, '(555) 010-0146;229'],
        Names: ['Dana Example'],
        Emails: ['dana@card.example.test'],
        Phones: ['(555) 010-0145'],
      },
    };
    expect(contactMethodsFromPersonProperties(person)).not.toEqual([]);

    const after = applied(person, droppedContactsPatch(person, []));

    expect(contactMethodsFromPersonProperties(after)).toEqual([]);
    expect(after.properties).toMatchObject({
      Names: person.properties.Names,
      Emails: person.properties.Emails,
      Phones: person.properties.Phones,
    });
  });
});

describe('removedContactPatch', () => {
  it('removes every copy of the one contact, by join key, and nothing else', () => {
    const person = {
      properties: {
        phone: '5550100148',
        phones: ['(555) 010-0148', '(555) 010-0149'],
        emails: ['x@example.test'],
      },
    };

    expect(removedContactPatch(person, 'phone', '+1 555 010 0148')).toEqual({
      phone: null,
      phones: ['(555) 010-0149'],
    });
  });

  it('returns nothing to write when the row holds no copy of it', () => {
    expect(
      removedContactPatch({ properties: { phones: ['(555) 010-0149'] } }, 'phone', '(555) 010-0148'),
    ).toEqual({});
  });
});

describe('contactsToReconcile', () => {
  // The edit form seeds from `identifiers` — index rows AND the property-only
  // rows above — and a save re-submits the lot. Only what the user asserted
  // may reach `replaceForEntity`.
  const person = {
    indexed: [{ kind: 'email', valueNormalized: 'priya@example.org' }],
    stated: contactMethodsFromPersonProperties({
      properties: {
        emails: ['priya@example.org', { value: 'p.castellano@example.com', type: 'work' }],
        // An office line another card lists too: on the record, deliberately
        // off the index (migration 20260930022046, step 2b).
        phones: ['4155550188'],
      },
    }),
  };

  it('drops a property-only row the user did not touch', () => {
    const submitted = [
      { kind: 'email' as const, value: 'priya@example.org', label: '' },
      { kind: 'email' as const, value: 'p.castellano@example.com', label: 'work' },
      { kind: 'phone' as const, value: '4155550188', label: '' },
    ];

    expect(contactsToReconcile(submitted, person)).toEqual([submitted[0]]);
  });

  it('matches on the join key, so a reformatted spelling is still untouched', () => {
    const submitted = [{ kind: 'phone' as const, value: '+1 (415) 555-0188', label: null }];

    expect(contactsToReconcile(submitted, person)).toEqual([]);
  });

  it('keeps a property-only row the user relabelled — that is an assertion', () => {
    const relabelled = { kind: 'phone' as const, value: '4155550188', label: 'Office' };

    expect(contactsToReconcile([relabelled], person)).toEqual([relabelled]);
  });

  it('keeps a row the user typed', () => {
    const typed = { kind: 'email' as const, value: 'tomasz.okafor@example.org', label: '' };

    expect(contactsToReconcile([typed], person)).toEqual([typed]);
  });

  it('keeps every row already indexed for the person, so a label or primary edit still lands', () => {
    const indexed = { kind: 'email' as const, value: 'Priya@Example.org', label: 'home' };

    expect(contactsToReconcile([indexed], person)).toEqual([indexed]);
  });

  it('passes an unusable value through for replaceForEntity to skip', () => {
    const blank = { kind: 'phone' as const, value: 'n/a', label: '' };

    expect(contactsToReconcile([blank], person)).toEqual([blank]);
  });
});
