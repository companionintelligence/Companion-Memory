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
