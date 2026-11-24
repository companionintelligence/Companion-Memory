import { BadRequestException } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';

import { GlobalUID } from '../types/GlobalUID';
import type { PersonContactInput } from '../types/PersonContactInput';

import { PersonResolver } from './PersonResolver';

const USER = '00000000-0000-4000-8000-00000000000a';
const PERSON = '00000000-0000-4000-8000-0000000000b1';

/**
 * A contact value the shared rule stores nothing for, in the person editor.
 *
 * `updatePerson` writes contacts to `ci.entity_identifiers` and nowhere else, so
 * a value `normalizeIdentifier` refuses — since the extension fix, a phone
 * carrying one — used to be skipped without a word and lost. It is refused now,
 * before anything is written. The one exception is a value the person's own row
 * already states: the form shows it (as typed) and sends it back on every save,
 * so refusing it would make the person uneditable.
 */
function makeResolver(properties: Record<string, unknown> = {}) {
  const person = {
    id: PERSON,
    name: 'Dana Okafor',
    email: null,
    properties,
    addresses: [],
  };

  const personService = {
    findById: jest.fn(async () => person),
    patch: jest.fn(async () => person),
  };
  const entityIdentifierService = {
    replaceForEntity: jest.fn(async () => ({ conflicts: [], unusable: [] })),
    addForEntity: jest.fn(async () => null),
    // The pre-write conflict check (#2798) runs on the same list; nothing
    // here conflicts.
    findConflicts: jest.fn(async () => []),
    listForEntities: jest.fn(async () => new Map()),
  };
  const personIdentifiersLoader = { clear: jest.fn() };
  // Nothing else is reached.
  const unused = {} as never;

  const resolver = new PersonResolver(
    personService as never,
    unused,
    unused,
    unused,
    unused,
    entityIdentifierService as never,
    personIdentifiersLoader as never,
    unused,
    unused,
    unused,
  );

  return { resolver, personService, entityIdentifierService };
}

const context = { userId: USER } as RequestContext;

function update(resolver: PersonResolver, contacts: PersonContactInput[]) {
  return resolver.updatePerson(context, {
    id: GlobalUID.encode('person', PERSON),
    name: 'Dana Okafor (renamed)',
    contacts,
  });
}

/** The exception `attempt` rejects with, for its `details`. */
async function refusal(attempt: Promise<unknown>): Promise<BadRequestException> {
  const error = await attempt.then(
    () => null,
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(BadRequestException);

  return error as BadRequestException;
}

function detailsOf(exception: BadRequestException) {
  return (exception.getResponse() as { details: unknown }).details;
}

describe('PersonResolver.updatePerson — contacts the shared rule refuses', () => {
  it('refuses a typed extension number before writing anything', async () => {
    const { resolver, personService, entityIdentifierService } = makeResolver();

    const exception = await refusal(
      update(resolver, [
        { kind: 'phone', value: '212-555-0148 x31', label: 'work' },
        { kind: 'phone', value: '212 555 0149' },
      ]),
    );

    expect(exception.message).toBe(
      '"212-555-0148 x31" includes an extension, so it can\'t be used to match this person to calls and ' +
        'messages. Keep it in a note instead.',
    );
    expect(detailsOf(exception)).toEqual({
      refusedContacts: [{ kind: 'phone', value: '212-555-0148 x31', label: 'work', reason: 'extension' }],
    });
    // Nothing was reconciled or patched, so cancelling after the error loses
    // nothing — including a number the extension was typed over.
    expect(entityIdentifierService.replaceForEntity).not.toHaveBeenCalled();
    expect(personService.patch).not.toHaveBeenCalled();
  });

  it('saves when the extension number is one the row already holds, so the form round-trip is not a trap', async () => {
    // The shape the extension migration leaves: a number typed into the form
    // moved out of the index into `properties.phones`, shown on the card as
    // typed. The form sends it back as shown, label and all.
    const { resolver, personService, entityIdentifierService } = makeResolver({
      phones: [{ value: '212-555-0148 x31', type: 'work' }],
    });

    const contacts = [
      { kind: 'phone', value: '212-555-0148 x31', label: 'work', isPrimary: true },
      { kind: 'email', value: 'dana@example.com', isPrimary: true },
    ];

    await expect(update(resolver, contacts)).resolves.toEqual(expect.objectContaining({ success: true }));

    // Passed on as sent; replaceForEntity stores nothing for it and says so.
    expect(entityIdentifierService.replaceForEntity).toHaveBeenCalledWith(
      USER,
      PERSON,
      ['email', 'phone'],
      [
        { kind: 'phone', value: '212-555-0148 x31', label: 'work', isPrimary: true },
        { kind: 'email', value: 'dana@example.com', label: undefined, isPrimary: true },
      ],
    );
    expect(personService.patch).toHaveBeenCalledWith(
      expect.anything(),
      PERSON,
      expect.objectContaining({ name: 'Dana Okafor (renamed)' }),
      { handEdit: true },
    );
  });

  it('refuses a relabel of the number the row holds: the label has nowhere to go', async () => {
    const { resolver, entityIdentifierService } = makeResolver({
      phones: [{ value: '212-555-0148 x31', type: 'work' }],
    });

    const exception = await refusal(
      update(resolver, [{ kind: 'phone', value: '212-555-0148 x31', label: 'mobile' }]),
    );

    expect(detailsOf(exception)).toEqual({
      refusedContacts: [{ kind: 'phone', value: '212-555-0148 x31', label: 'mobile', reason: 'extension' }],
    });
    expect(entityIdentifierService.replaceForEntity).not.toHaveBeenCalled();
  });

  it('still refuses an edit of the number the row holds', async () => {
    const { resolver, entityIdentifierService } = makeResolver({ phones: ['212-555-0148 x31'] });

    const exception = await refusal(update(resolver, [{ kind: 'phone', value: '212-555-0148 x32' }]));

    expect(detailsOf(exception)).toEqual({
      refusedContacts: [{ kind: 'phone', value: '212-555-0148 x32', label: null, reason: 'extension' }],
    });
    expect(entityIdentifierService.replaceForEntity).not.toHaveBeenCalled();
  });

  it('names every refused value, and tells an extension apart from a value that is not a number', async () => {
    const { resolver } = makeResolver();

    const exception = await refusal(
      update(resolver, [
        { kind: 'phone', value: '(212) 555-0147;229' },
        { kind: 'phone', value: 'front desk' },
        { kind: 'phone', value: '212-555-0150 ext. 12' },
        // Blank rows are nothing to lose, and never reported.
        { kind: 'phone', value: '   ' },
      ]),
    );

    expect(exception.message).toBe(
      '"(212) 555-0147;229" and "212-555-0150 ext. 12" include an extension, so they can\'t be used to ' +
        'match this person to calls and messages. Keep them in a note instead. ' +
        '"front desk" does not normalize to a usable phone.',
    );
    expect(detailsOf(exception)).toEqual({
      refusedContacts: [
        { kind: 'phone', value: '(212) 555-0147;229', label: null, reason: 'extension' },
        { kind: 'phone', value: 'front desk', label: null, reason: 'unusable' },
        { kind: 'phone', value: '212-555-0150 ext. 12', label: null, reason: 'extension' },
      ],
    });
  });

  it('leaves an update without contacts alone', async () => {
    const { resolver, personService, entityIdentifierService } = makeResolver();

    await expect(
      resolver.updatePerson(context, { id: GlobalUID.encode('person', PERSON), name: 'Dana' }),
    ).resolves.toEqual(expect.objectContaining({ success: true }));

    expect(entityIdentifierService.replaceForEntity).not.toHaveBeenCalled();
    expect(personService.patch).toHaveBeenCalled();
  });
});

describe('PersonResolver.addPersonIdentifier — the same refusal', () => {
  it('carries the refused value in details, as updatePerson does', async () => {
    const { resolver } = makeResolver();

    const exception = await refusal(
      resolver.addPersonIdentifier(context, {
        personId: GlobalUID.encode('person', PERSON),
        kind: 'phone',
        value: '(212) 555-0147;229',
      }),
    );

    expect(detailsOf(exception)).toEqual({
      refusedContacts: [{ kind: 'phone', value: '(212) 555-0147;229', label: null, reason: 'extension' }],
    });
  });
});
