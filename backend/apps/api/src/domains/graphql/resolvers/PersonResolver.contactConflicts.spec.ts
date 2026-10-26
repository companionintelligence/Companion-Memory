import { ConflictException } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';
import { EntityIdentifierService } from '@ci/domains/graph';

import {
  type EntityIdentifierRow,
  makeInMemoryEntityIdentifiers,
  silentLogger,
} from '../../__tests__/support/inMemoryEntityIdentifiers';
import { GlobalUID } from '../types/GlobalUID';
import type { PersonContactInput } from '../types/PersonContactInput';

import { PersonResolver } from './PersonResolver';

const USER = '00000000-0000-4000-8000-00000000000a';
const DANA = '00000000-0000-4000-8000-0000000000b1';
const SAM = '00000000-0000-4000-8000-0000000000c2';

/**
 * `updatePerson` with a contact value another person already holds.
 *
 * `replaceForEntity` only meets such a value at the insert, after it has
 * deleted every row missing from the list — so the edit used to fail AFTER the
 * contact changes were saved, with the name / description / address patch
 * skipped: a rename was lost while the contacts changed, and Cancel on the
 * error could not bring back a number the user had edited into the claimed
 * value. The conflict is now found with a read and refused before anything is
 * written.
 *
 * The identifier service is the real one, over an in-memory
 * `ci.entity_identifiers` that records every write, so "nothing was written" is
 * checked against the table rather than inferred from which mocks were called.
 */
const SEED: EntityIdentifierRow[] = [
  {
    ownerUserId: USER,
    entityId: DANA,
    kind: 'email',
    valueNormalized: 'dana@example.com',
    label: 'work',
    isPrimary: true,
    source: 'user',
  },
  {
    ownerUserId: USER,
    entityId: DANA,
    kind: 'phone',
    valueNormalized: '4155550100',
    rawValue: '(415) 555-0100',
    label: 'mobile',
    isPrimary: true,
    source: 'user',
  },
  // Sam is a colleague: a separate person who already holds these two.
  {
    ownerUserId: USER,
    entityId: SAM,
    kind: 'email',
    valueNormalized: 'sam@example.com',
    source: 'import:google',
  },
  { ownerUserId: USER, entityId: SAM, kind: 'phone', valueNormalized: '4155550199', source: 'import:google' },
];

function makeResolver(seed: EntityIdentifierRow[] = SEED) {
  const table = makeInMemoryEntityIdentifiers(seed);
  const entityIdentifierService = new EntityIdentifierService(
    table.repository as never,
    silentLogger as never,
  );

  const person = { id: DANA, name: 'Dana Okafor', email: null, properties: {}, addresses: [] };
  const personService = {
    findById: jest.fn(async () => person),
    patch: jest.fn(async (_context: unknown, _id: string, patch: { name?: string }) => ({
      ...person,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
    })),
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
    entityIdentifierService,
    personIdentifiersLoader as never,
    unused,
    unused,
    unused,
  );

  return { resolver, table, personService, personIdentifiersLoader };
}

const context = { userId: USER } as RequestContext;

function renameWith(resolver: PersonResolver, contacts: PersonContactInput[]) {
  return resolver.updatePerson(context, {
    id: GlobalUID.encode('person', DANA),
    name: 'Dana Okafor-Reyes',
    contacts,
  });
}

describe('PersonResolver.updatePerson — a contact another person already holds', () => {
  it('refuses the whole edit before writing anything, so nothing is half-applied', async () => {
    const { resolver, table, personService, personIdentifiersLoader } = makeResolver();

    // Rename Dana, add Sam's address, and edit Dana's number into Sam's.
    const attempt = renameWith(resolver, [
      { kind: 'email', value: 'dana@example.com', label: 'work', isPrimary: true },
      { kind: 'email', value: 'sam@example.com', label: 'work' },
      { kind: 'phone', value: '(415) 555-0199', label: 'mobile', isPrimary: true },
    ]);

    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toThrow(
      'sam@example.com, (415) 555-0199 already belong to another person. ' +
        'Merge the two people instead of re-assigning it.',
    );

    // Not one statement against the index: Dana's old number — the row the
    // edit replaced — is still there for Cancel to come back to.
    expect(table.writes).toEqual([]);
    expect(table.rows).toEqual(SEED);
    // And the rename was not applied on its own either.
    expect(personService.patch).not.toHaveBeenCalled();
    expect(personIdentifiersLoader.clear).not.toHaveBeenCalled();
  });

  it('finds the holder by the normalized value, and names the value as it was typed', async () => {
    const { resolver, table, personService } = makeResolver();

    await expect(
      renameWith(resolver, [
        { kind: 'email', value: 'dana@example.com' },
        { kind: 'email', value: 'SAM@Example.com' },
      ]),
    ).rejects.toThrow(
      'SAM@Example.com already belongs to another person. Merge the two people instead of re-assigning it.',
    );

    expect(table.writes).toEqual([]);
    expect(personService.patch).not.toHaveBeenCalled();
  });

  it("saves when every value is free or already this person's own, however it is spelled", async () => {
    const { resolver, table, personService } = makeResolver();

    const saved = await renameWith(resolver, [
      { kind: 'email', value: 'Dana@Example.com', label: 'home', isPrimary: true },
      { kind: 'email', value: 'dana.okafor@example.org' },
      { kind: 'phone', value: '+1 415 555 0100', label: 'mobile', isPrimary: true },
    ]);

    expect(saved).toEqual(expect.objectContaining({ success: true }));
    expect(personService.patch).toHaveBeenCalledWith(
      expect.anything(),
      DANA,
      expect.objectContaining({ name: 'Dana Okafor-Reyes' }),
      { handEdit: true },
    );
    expect(
      table.rows
        .filter((row) => row.entityId === DANA)
        .map((row) => [row.kind, row.valueNormalized, row.label ?? null])
        .sort(),
    ).toEqual([
      ['email', 'dana.okafor@example.org', null],
      ['email', 'dana@example.com', 'home'],
      ['phone', '4155550100', 'mobile'],
    ]);
    // Sam keeps his.
    expect(table.rows.filter((row) => row.entityId === SAM)).toHaveLength(2);
  });

  it('still reports a value another writer claims between the check and the write', async () => {
    const { resolver, table } = makeResolver();

    // An import (or a message minting a participant stub) takes the address
    // just after the read has found it free.
    const lookup = table.repository.manager.query;
    table.repository.manager.query = async (sql: string, params: unknown[]) => {
      const answer = await lookup(sql, params);
      table.rows.push({
        ownerUserId: USER,
        entityId: SAM,
        kind: 'email',
        valueNormalized: 'sam@work.example',
      });

      return answer;
    };

    await expect(
      renameWith(resolver, [
        { kind: 'email', value: 'dana@example.com' },
        { kind: 'email', value: 'sam@work.example' },
      ]),
    ).rejects.toThrow(
      'sam@work.example already belongs to another person. Merge the two people instead of re-assigning it.',
    );

    // Surfaced, and still not taken from its holder.
    expect(table.rows.find((row) => row.valueNormalized === 'sam@work.example')?.entityId).toBe(SAM);
  });

  it('does not read the index for an update that leaves contacts alone', async () => {
    const { resolver, table, personService } = makeResolver();
    const lookup = jest.spyOn(table.repository.manager, 'query');

    await expect(
      resolver.updatePerson(context, { id: GlobalUID.encode('person', DANA), name: 'Dana' }),
    ).resolves.toEqual(expect.objectContaining({ success: true }));

    expect(lookup).not.toHaveBeenCalled();
    expect(table.writes).toEqual([]);
    expect(personService.patch).toHaveBeenCalled();
  });
});
