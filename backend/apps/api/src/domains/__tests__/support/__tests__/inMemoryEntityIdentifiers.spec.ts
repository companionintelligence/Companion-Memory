import { In, Not } from 'typeorm';

import { makeInMemoryEntityIdentifiers } from '../inMemoryEntityIdentifiers';

const OWNER = '00000000-0000-0000-0000-0000000000aa';
const OTHER_OWNER = '00000000-0000-0000-0000-0000000000ab';
const DANA = '00000000-0000-0000-0000-0000000000bb';
const SAM = '00000000-0000-0000-0000-0000000000cc';

const LOOKUP = `SELECT kind, value_normalized, entity_id
                  FROM ci.entity_identifiers
                 WHERE owner_user_id = $1
                   AND (kind, value_normalized) IN (($2, $3))`;

/**
 * The stand-in for `ci.entity_identifiers` that the identifier specs rely on to
 * say what was written. If it answers differently from the table, they prove
 * nothing, so its own contract is pinned here.
 */
describe('makeInMemoryEntityIdentifiers', () => {
  const seed = [
    { ownerUserId: OWNER, entityId: DANA, kind: 'email', valueNormalized: 'dana@example.com' },
    { ownerUserId: OWNER, entityId: SAM, kind: 'email', valueNormalized: 'sam@example.com' },
    // The same value under another appliance user is a different tuple.
    { ownerUserId: OTHER_OWNER, entityId: SAM, kind: 'email', valueNormalized: 'dana@example.com' },
  ];

  it('ignores an insert whose tuple is taken, like ON CONFLICT DO NOTHING, and still records it', async () => {
    const { repository, rows, writes } = makeInMemoryEntityIdentifiers(seed);

    for (const valueNormalized of ['dana@example.com', 'new@example.com']) {
      await repository
        .createQueryBuilder()
        .insert()
        .into()
        .values({ ownerUserId: OWNER, entityId: SAM, kind: 'email', valueNormalized })
        .orIgnore()
        .execute();
    }

    expect(
      rows.find((row) => row.ownerUserId === OWNER && row.valueNormalized === 'dana@example.com'),
    ).toEqual(expect.objectContaining({ entityId: DANA }));
    expect(
      writes.map((write) => (write.op === 'insert' ? [write.row.valueNormalized, write.ignored] : null)),
    ).toEqual([
      ['dana@example.com', true],
      ['new@example.com', false],
    ]);
  });

  it('matches In(...), as listForEntities passes it, and refuses an operator it does not model', async () => {
    const { repository } = makeInMemoryEntityIdentifiers(seed);

    await expect(
      repository.find({ where: { ownerUserId: OWNER, entityId: In([DANA, SAM]) } }),
    ).resolves.toHaveLength(2);
    await expect(repository.find({ where: { ownerUserId: OWNER, entityId: Not(DANA) } })).rejects.toThrow(
      'unsupported criteria on "entityId"',
    );
  });

  it("answers the holder lookup for the owner's rows only, and refuses SQL it does not know", async () => {
    const { repository } = makeInMemoryEntityIdentifiers(seed);

    await expect(repository.manager.query(LOOKUP, [OWNER, 'email', 'dana@example.com'])).resolves.toEqual([
      { kind: 'email', value_normalized: 'dana@example.com', entity_id: DANA },
    ]);
    await expect(repository.manager.query('SELECT 1', [])).rejects.toThrow('cannot answer');
  });
});
