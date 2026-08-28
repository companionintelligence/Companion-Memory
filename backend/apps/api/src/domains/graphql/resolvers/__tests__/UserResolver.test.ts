import type { Person } from '@ci/domains/memory';
import type { User } from '@ci/domains/user';

import { UserResolver } from '../UserResolver';

/**
 * `UserType.avatarUrl` — the caller's own avatar.
 *
 * It is deliberately resolved off `PersonService.findSelf` (the `is_self`
 * Person), not the `entity()` field's `users.entity_id` pointer: a merge can
 * move `is_self` onto a different row without that pointer following it. So
 * the property worth pinning here is that this field goes through
 * `findSelf`, threads the caller's own scope into it, and never throws or
 * substitutes a stranger's data when there is nothing to show.
 */

const OWNER = 'owner-1';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: OWNER,
    name: 'Liam',
    email: 'liam@example.com',
    onboarded: true,
    onboardedAt: null,
    timezone: 'UTC',
    entityId: 'entity-1',
    ...overrides,
  } as unknown as User;
}

function makePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: 'person-self',
    name: 'Liam',
    properties: {},
    ...overrides,
  } as unknown as Person;
}

function build(overrides: { userService?: object; nodeService?: object; personService?: object } = {}) {
  const userService = {
    findById: jest.fn().mockResolvedValue(makeUser()),
    update: jest.fn(),
    ...overrides.userService,
  };
  const nodeService = {
    findNodeByUserId: jest.fn(),
    ...overrides.nodeService,
  };
  const personService = {
    findSelf: jest.fn().mockResolvedValue(null),
    findById: jest.fn(),
    ...overrides.personService,
  };

  const resolver = new UserResolver(userService as never, nodeService as never, personService as never);
  const context = { userId: OWNER } as never;

  return { resolver, userService, nodeService, personService, context };
}

describe('UserResolver.avatarUrl', () => {
  it("returns the owner's own is_self Person's avatarUrl", async () => {
    const { resolver, personService, context } = build({
      personService: {
        findSelf: jest
          .fn()
          .mockResolvedValue(makePerson({ properties: { avatar_url: 'https://x/liam.png' } })),
      },
    });

    const result = await resolver.avatarUrl(context);

    expect(result).toBe('https://x/liam.png');
    // The service context — not a raw id and not `undefined` — is what carries
    // the owner into the scoped lookup.
    expect(personService.findSelf).toHaveBeenCalledTimes(1);
    expect(personService.findSelf).toHaveBeenCalledWith({ userId: OWNER });
  });

  it('returns null cleanly when no is_self Person exists', async () => {
    const { resolver, context } = build({
      personService: { findSelf: jest.fn().mockResolvedValue(null) },
    });

    const result = await resolver.avatarUrl(context);

    expect(result).toBeNull();
  });

  it('returns null cleanly when the is_self Person has no avatar', async () => {
    const { resolver, context } = build({
      personService: { findSelf: jest.fn().mockResolvedValue(makePerson({ properties: {} })) },
    });

    const result = await resolver.avatarUrl(context);

    expect(result).toBeNull();
  });

  it('does not throw when the is_self Person carries other jsonb properties, and only reads avatar_url', async () => {
    const { resolver, context } = build({
      personService: {
        findSelf: jest.fn().mockResolvedValue(
          makePerson({
            properties: { avatar_url: 'https://x/liam.png', ssn: 'do-not-leak', vendor_notes: 'private' },
          }),
        ),
      },
    });

    const result = await resolver.avatarUrl(context);

    expect(result).toBe('https://x/liam.png');
  });
});
