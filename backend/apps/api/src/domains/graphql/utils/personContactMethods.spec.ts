import type { PersonIdentifierType } from '../types/PersonIdentifierType';

import { contactMethodsFromPersonProperties, mergePersonIdentifiers } from './personContactMethods';

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
