import { ConflictException } from '@nestjs/common';

import { EntityIdentifierService } from '@ci/domains/graph';

import { GlobalUID } from '../../types/GlobalUID';
import { PersonResolver } from '../PersonResolver';

/**
 * `updatePerson` with `contacts`: the edit form's save.
 *
 * The form seeds its contact list from `identifiers` — index rows AND the
 * contacts a person's `properties` state without an index row — and re-submits
 * the whole list on every save. Migration 20260930022046 puts values into
 * `properties.emails/phones` that it deliberately keeps out of the index (a
 * number or address another card lists under a different name), so an
 * untouched save must not change the index for them — neither by indexing them
 * as user-verified nor by failing the save over whoever holds them.
 *
 * The real `EntityIdentifierService` runs against an in-memory
 * `ci.entity_identifiers` keyed on its unique tuple, so first-writer-wins and
 * the user-verified insert are exercised rather than mocked away.
 */

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const PERSON = '00000000-0000-4000-8000-0000000000b1';
const STUB = '00000000-0000-4000-8000-0000000000c2';

interface Row {
  ownerUserId: string;
  entityId: string;
  kind: string;
  valueNormalized: string;
  rawValue?: string | null;
  label?: string | null;
  isPrimary?: boolean;
  source?: string | null;
  verifiedAt?: Date | null;
}

function makeIdentifierService(seed: Row[]) {
  const rows: Row[] = seed.map((row) => ({ ...row }));
  const keyOf = (row: { kind: string; valueNormalized: string }) => `${row.kind}:${row.valueNormalized}`;

  let pending: Row | null = null;
  const builder: Record<string, unknown> = {};
  builder.insert = () => builder;
  builder.into = () => builder;
  builder.values = (row: Row) => {
    pending = row;

    return builder;
  };

  builder.orIgnore = () => builder;
  builder.execute = async () => {
    if (pending && !rows.some((row) => keyOf(row) === keyOf(pending!))) {
      // `verifiedAt` arrives as a `() => 'now()'` SQL fragment; store a date.
      rows.push({ ...pending, verifiedAt: new Date() });
    }

    pending = null;

    return { identifiers: [] };
  };

  // `listForEntities` passes `In([...])`, `replaceForEntity` a bare id.
  const entityIdsOf = (entityId: unknown): string[] =>
    typeof entityId === 'string' ? [entityId] : ((entityId as { value: string[] }).value ?? []);

  const repository = {
    create: (row: Record<string, unknown>) => row,
    createQueryBuilder: () => builder,
    find: async ({ where }: { where: { ownerUserId: string; entityId: unknown } }) =>
      rows.filter(
        (row) => row.ownerUserId === where.ownerUserId && entityIdsOf(where.entityId).includes(row.entityId),
      ),
    findOne: async ({ where }: { where: { kind: string; valueNormalized: string } }) =>
      rows.find((row) => keyOf(row) === keyOf(where)) ?? null,
    update: async (where: { kind: string; valueNormalized: string }, patch: Record<string, unknown>) => {
      const row = rows.find((candidate) => keyOf(candidate) === keyOf(where));
      if (row) {
        Object.assign(row, patch);
      }

      return { affected: row ? 1 : 0 };
    },
    delete: async (keys: Array<{ kind: string; valueNormalized: string }>) => {
      for (const key of keys) {
        const index = rows.findIndex((row) => keyOf(row) === keyOf(key));
        if (index >= 0) {
          rows.splice(index, 1);
        }
      }

      return { affected: keys.length };
    },
    // findConflicts looks holders up with one owner-scoped IN query. Answer it
    // from this table; anything else is a query the fake does not know.
    manager: {
      query: async (sql: string, params: unknown[] = []) => {
        if (!sql.includes('FROM ci.entity_identifiers') || params.length < 1) {
          throw new Error(`in-memory identifiers cannot answer: ${sql}`);
        }

        const ownerUserId = String(params[0]);
        const asked: Array<[string, string]> = [];
        for (let i = 1; i + 1 < params.length; i += 2) {
          asked.push([String(params[i]), String(params[i + 1])]);
        }

        return rows
          .filter(
            (row) =>
              row.ownerUserId === ownerUserId &&
              asked.some(([kind, value]) => row.kind === kind && row.valueNormalized === value),
          )
          .map((row) => ({
            kind: row.kind,
            value_normalized: row.valueNormalized,
            entity_id: row.entityId,
          }));
      },
    },
    metadata: { columns: { length: 5 } },
  };

  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  return { service: new EntityIdentifierService(repository as never, logger as never), rows };
}

function makeHarness({ seed = [], properties }: { seed?: Row[]; properties: Record<string, unknown> }) {
  const { service, rows } = makeIdentifierService(seed);
  const person = { id: PERSON, name: 'Priya Castellano', email: null, properties };
  const personService = {
    findById: jest.fn().mockResolvedValue(person),
    patch: jest.fn().mockImplementation(async (_context: unknown, _id: string, patch: { name?: string }) => ({
      ...person,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
    })),
  };
  const unused = {} as never;
  const resolver = new PersonResolver(
    personService as never,
    unused,
    unused,
    unused,
    unused,
    service,
    { clear: jest.fn() } as never,
    unused,
    unused,
    unused,
  );

  const save = (contacts: Array<{ kind: string; value: string; label?: string; isPrimary?: boolean }>) =>
    resolver.updatePerson(
      { userId: OWNER } as never,
      {
        id: GlobalUID.encode('person', PERSON),
        name: 'Priya Castellano-Reyes',
        contacts,
      } as never,
    );

  const heldBy = (kind: string, valueNormalized: string) =>
    rows.find((row) => row.kind === kind && row.valueNormalized === valueNormalized);

  return { save, rows, heldBy, personService };
}

const indexedEmail: Row = {
  ownerUserId: OWNER,
  entityId: PERSON,
  kind: 'email',
  valueNormalized: 'priya@example.org',
  source: null,
};

describe('PersonResolver.updatePerson — contacts the form was seeded with', () => {
  it('does not index an untouched property-only value on an unrelated save', async () => {
    // An office line another card lists too: the migration left it on the
    // record and off the index. Saving the form to fix the name must not make
    // every call from that office resolve to Priya.
    const { save, heldBy, personService } = makeHarness({
      seed: [indexedEmail],
      properties: { emails: ['priya@example.org'], phones: ['4155550188'] },
    });

    await expect(
      save([
        { kind: 'email', value: 'priya@example.org', label: '', isPrimary: true },
        { kind: 'phone', value: '4155550188', label: '', isPrimary: true },
      ]),
    ).resolves.toMatchObject({ success: true });

    expect(heldBy('phone', '4155550188')).toBeUndefined();
    expect(heldBy('email', 'priya@example.org')?.entityId).toBe(PERSON);
    expect(personService.patch).toHaveBeenCalledWith(
      expect.anything(),
      PERSON,
      expect.objectContaining({ name: 'Priya Castellano-Reyes' }),
      { handEdit: true },
    );
  });

  it('no longer fails the save over a value another person already holds', async () => {
    // A mail stub claimed the address first (first writer wins). The card
    // states it too, so the form shows it — re-submitting it untouched is not
    // an attempt to re-assign it.
    const { save, heldBy, personService } = makeHarness({
      seed: [{ ...indexedEmail, entityId: STUB, valueNormalized: 'p.castellano@example.com' }],
      properties: { emails: ['p.castellano@example.com'] },
    });

    await expect(
      save([{ kind: 'email', value: 'p.castellano@example.com', label: '', isPrimary: true }]),
    ).resolves.toMatchObject({ success: true });

    expect(heldBy('email', 'p.castellano@example.com')?.entityId).toBe(STUB);
    expect(personService.patch).toHaveBeenCalledTimes(1);
  });

  it('indexes a value the user typed', async () => {
    const { save, heldBy } = makeHarness({
      seed: [indexedEmail],
      properties: { emails: ['priya@example.org'] },
    });

    await save([
      { kind: 'email', value: 'priya@example.org', label: '', isPrimary: true },
      { kind: 'email', value: 'priya.reyes@example.com', label: 'work', isPrimary: false },
    ]);

    expect(heldBy('email', 'priya.reyes@example.com')).toMatchObject({
      entityId: PERSON,
      source: 'user',
      label: 'work',
    });
  });

  it('indexes a property-only value the user relabelled — that is an assertion', async () => {
    const { save, heldBy } = makeHarness({ properties: { phones: ['4155550188'] } });

    await save([{ kind: 'phone', value: '4155550188', label: 'Office', isPrimary: true }]);

    expect(heldBy('phone', '4155550188')).toMatchObject({
      entityId: PERSON,
      source: 'user',
      label: 'Office',
    });
  });

  it('still refuses a typed value another person holds, before patching anything', async () => {
    const { save, heldBy, personService } = makeHarness({
      seed: [{ ...indexedEmail, entityId: STUB, valueNormalized: 'tomasz.okafor@example.org' }],
      properties: {},
    });

    await expect(
      save([{ kind: 'email', value: 'tomasz.okafor@example.org', label: '' }]),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(heldBy('email', 'tomasz.okafor@example.org')?.entityId).toBe(STUB);
    expect(personService.patch).not.toHaveBeenCalled();
  });

  it('never re-creates an extension fake from a number the card keeps as typed', async () => {
    // "(212) 555-0147 x229" keys as 5550147229 under the truncating join key —
    // the fake the contact-card migration removes. A save that round-trips the
    // typed string must not put it back: untouched, it is dropped here, and
    // under a join key that refuses extensions it cannot be keyed at all.
    const { save, heldBy } = makeHarness({ properties: { phones: ['(212) 555-0147 x229'] } });

    await expect(
      save([{ kind: 'phone', value: '(212) 555-0147 x229', label: '', isPrimary: true }]),
    ).resolves.toMatchObject({ success: true });

    expect(heldBy('phone', '5550147229')).toBeUndefined();
  });

  it('still removes an indexed value the user deleted from the form', async () => {
    const { save, heldBy } = makeHarness({
      seed: [indexedEmail, { ...indexedEmail, kind: 'phone', valueNormalized: '4155550142' }],
      properties: { emails: ['priya@example.org'] },
    });

    await save([{ kind: 'email', value: 'priya@example.org', label: '', isPrimary: true }]);

    expect(heldBy('phone', '4155550142')).toBeUndefined();
    expect(heldBy('email', 'priya@example.org')?.entityId).toBe(PERSON);
  });
});
