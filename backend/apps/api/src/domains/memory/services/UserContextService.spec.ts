import { UserContextService, type UserContext } from './UserContextService';

/**
 * The Self page's whole purpose is that what you write there reaches the model.
 * It did not: `pickImportantProperties` allowlisted six keys, none of which the
 * identity editor writes, and the free-text "about" is an entity COLUMN that no
 * widening of that list could have reached. A user filled in who they are, saw
 * "Saved", and the Companion learned nothing.
 *
 * Both halves are exercised through the public surface — the private allowlist
 * via a formatted prompt — so the test constrains what the model SEES rather
 * than an implementation detail that could be renamed out from under it.
 */
function context(overrides: Partial<UserContext['currentUser']> = {}): UserContext {
  return {
    currentUser: {
      entityId: 'entity-1',
      name: 'Alex Rivera',
      username: 'alex',
      properties: {},
      about: null,
      dossier: null,
      ...overrides,
    },
    familyMembers: [],
    topPreferences: [],
    quickStats: { totalEntities: 0, totalPreferences: 0, totalDislikes: 0, familySize: 0 },
  };
}

// `pickImportantProperties` is private; reach it the way the service does.
function pick(service: UserContextService, properties: Record<string, unknown>) {
  return (
    service as unknown as {
      pickImportantProperties(p: Record<string, unknown>): Record<string, unknown>;
    }
  ).pickImportantProperties(properties);
}

describe('UserContextService', () => {
  const service = new UserContextService(
    {} as never,
    {} as never,
    { setContext: () => {}, warn: () => {}, error: () => {} } as never,
  );

  describe('pickImportantProperties', () => {
    // These are the exact keys `PersonResolver` writes for the Self editor's
    // Gender / Pronouns / Birthday / Job fields.
    it.each(['gender', 'pronouns', 'birth_date', 'job_title'])(
      'carries the Self editor’s %s through to the prompt',
      (key) => {
        expect(pick(service, { [key]: 'value' })).toHaveProperty(key, 'value');
      },
    );

    it('derives an age from a birth date so nothing has to do date arithmetic', () => {
      const born = new Date();
      born.setFullYear(born.getFullYear() - 30);
      born.setDate(born.getDate() - 1);

      expect(pick(service, { birth_date: born.toISOString().slice(0, 10) })).toMatchObject({ age: 30 });
    });

    it('never overwrites an age the graph already holds', () => {
      expect(pick(service, { age: 41, birth_date: '1990-01-01' })).toMatchObject({ age: 41 });
    });

    it('produces no age from a malformed or future birth date', () => {
      expect(pick(service, { birth_date: 'not a date' }).age).toBeUndefined();
      expect(pick(service, { birth_date: '2999-01-01' }).age).toBeUndefined();
      expect(pick(service, { birth_date: 42 }).age).toBeUndefined();
    });

    it('still drops properties nobody asked the model to know', () => {
      expect(pick(service, { schedule: { wake: '07:00' }, secret: 'x' })).toEqual({});
    });
  });

  describe('formatContextForSystemPrompt', () => {
    it('states who the user is, in the words they wrote', () => {
      const prompt = service.formatContextForSystemPrompt(
        context({
          about: 'I run a small bakery and I am learning Portuguese.',
          properties: { gender: 'non-binary', pronouns: 'they/them', age: 34 },
        }),
      );

      expect(prompt).toContain('I run a small bakery');
      expect(prompt).toContain('non-binary');
      expect(prompt).toContain('they/them');
      expect(prompt).toContain('34');
    });

    it('says nothing about an About the user has not written', () => {
      expect(service.formatContextForSystemPrompt(context())).not.toContain('- About:');
    });

    it('does not print an empty About for whitespace', () => {
      expect(service.formatContextForSystemPrompt(context({ about: '' }))).not.toContain('- About:');
    });
  });
});

/**
 * Self > About you lists family as "<name> (<role>)". PARENT_OF names a parent
 * or a child depending on which way the edge points, so the list has to know
 * the direction: before it was kept, the user's mother and the user's son both
 * came back as plain `PARENT_OF`.
 */
describe('UserContextService family members', () => {
  const ME = 'me';
  const node = (entity_id: string, name: string) => ({ entity_id, name, properties: {} });

  async function familyOf(
    edges: Array<{ from_entity_id: string; to_entity_id: string; relationship_type: string }>,
  ) {
    const graphQuery = {
      traverseGraph: jest.fn().mockResolvedValue({
        nodes: new Map([
          [ME, node(ME, 'Alex Rivera')],
          ['mom', node('mom', 'Morgan Rivera')],
          ['son', node('son', 'Riley Rivera')],
          ['sis', node('sis', 'Jordan Rivera')],
        ]),
        edges,
      }),
    };
    const service = new UserContextService(
      graphQuery as never,
      {} as never,
      { setContext: () => {}, warn: () => {}, error: () => {} } as never,
    );
    // Everything but the family read is beside the point here.
    const internals = service as unknown as Record<string, unknown>;
    jest
      .spyOn(internals as never, 'resolveUserEntity' as never)
      .mockResolvedValue(node(ME, 'Alex Rivera') as never);
    jest.spyOn(internals as never, 'getTopPreferences' as never).mockResolvedValue([] as never);
    jest.spyOn(internals as never, 'getTopDislikes' as never).mockResolvedValue([] as never);
    jest.spyOn(internals as never, 'getQuickStats' as never).mockResolvedValue({ totalEntities: 4 } as never);
    jest.spyOn(internals as never, 'getUsernameFromUsersTable' as never).mockResolvedValue('alex' as never);

    return (await service.getUserContextForLLM('user-1'))?.familyMembers ?? [];
  }

  it('says which way each relationship points from the user', async () => {
    const family = await familyOf([
      { from_entity_id: 'mom', to_entity_id: ME, relationship_type: 'PARENT_OF' },
      { from_entity_id: ME, to_entity_id: 'son', relationship_type: 'PARENT_OF' },
      { from_entity_id: 'sis', to_entity_id: ME, relationship_type: 'SIBLING_OF' },
    ]);

    expect(family.map((member) => [member.name, member.relationship, member.direction])).toEqual([
      ['Morgan Rivera', 'PARENT_OF', 'incoming'],
      ['Riley Rivera', 'PARENT_OF', 'outgoing'],
      ['Jordan Rivera', 'SIBLING_OF', 'incoming'],
    ]);
  });
});

/**
 * The owner has no pointer yet, and the only identity claim is an `is_self`
 * row: resolveUserEntity caches it in `ci.users.entity_id`. Onboarding and an
 * import can point the account at its self Person between this read and that
 * write, so the write itself must still require the pointer to be empty.
 */
describe('UserContextService self fallback', () => {
  it('caches the is_self row only while the pointer is still empty, checked in the UPDATE', async () => {
    const query = jest.fn(async (sql: string, _params?: unknown[]): Promise<unknown[]> => {
      if (sql.includes('FROM ci.users')) {
        return [{ entity_id: null }];
      }

      if (sql.includes('FROM ci.entities')) {
        return [{ entity_id: 'self-1' }];
      }

      return [];
    });
    const graphQuery = { getNode: jest.fn().mockResolvedValue({ entity_id: 'self-1', name: 'Alex Rivera' }) };
    const service = new UserContextService(
      graphQuery as never,
      { query } as never,
      { setContext: () => {}, warn: () => {}, error: () => {} } as never,
    );

    const entity = await (
      service as unknown as { resolveUserEntity(userId: string): Promise<{ entity_id: string } | null> }
    ).resolveUserEntity('user-1');

    expect(entity?.entity_id).toBe('self-1');
    const write = query.mock.calls.find(([sql]) => sql.includes('UPDATE ci.users'));
    expect(write?.[0]).toMatch(/WHERE id = \$1 AND entity_id IS NULL/);
    expect(write?.[1]).toEqual(['user-1', 'self-1']);
  });
});
