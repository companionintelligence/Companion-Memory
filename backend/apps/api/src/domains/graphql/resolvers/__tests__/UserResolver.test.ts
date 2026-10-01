import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BadRequestException } from '@nestjs/common';
import { buildSchema, parse, validate } from 'graphql';

import type { Person } from '@ci/domains/memory';
import { TIME_FORMATS, type TimeFormat, type User } from '@ci/domains/user';

import { TimeFormatEnum, UserType } from '../../types/UserType';
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
    timeFormat: 'auto',
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

/**
 * `updateCurrentUser` and the hour-cycle preference (`ci.users.time_format`).
 *
 * The web app's Settings › Preferences card saves the timezone and the time format through this
 * one mutation, sending only the fields that changed. So the properties worth pinning are that
 * each field is written only when it is present, that the two can be written together, and that
 * nothing reaches the NOT NULL column except the three values its CHECK accepts.
 */
describe('UserResolver.updateCurrentUser — time format', () => {
  it.each(TIME_FORMATS)('saves %s for the caller, and echoes it back', async (timeFormat) => {
    const { resolver, userService, context } = build({
      userService: { update: jest.fn().mockResolvedValue(makeUser({ timeFormat })) },
    });

    const result = await resolver.updateCurrentUser(context, { timeFormat: timeFormat as TimeFormatEnum });

    // Scoped to the caller's own row, and nothing but the one field.
    expect(userService.update).toHaveBeenCalledWith({ userId: OWNER }, OWNER, { timeFormat });
    expect(result?.timeFormat).toBe(timeFormat);
  });

  it('refuses an explicit null instead of writing it into a NOT NULL column', async () => {
    const { resolver, userService, context } = build();

    await expect(resolver.updateCurrentUser(context, { timeFormat: null })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(userService.update).not.toHaveBeenCalled();
  });

  it('refuses a value outside the enum, for a caller that got past GraphQL validation', async () => {
    const { resolver, userService, context } = build();

    await expect(
      resolver.updateCurrentUser(context, { timeFormat: 'h24' as TimeFormatEnum }),
    ).rejects.toThrow('Invalid time format: h24');
    expect(userService.update).not.toHaveBeenCalled();
  });

  it('leaves the time format alone when a save only changes the timezone', async () => {
    const { resolver, userService, context } = build({
      userService: { update: jest.fn().mockResolvedValue(makeUser({ timezone: 'Europe/London' })) },
    });

    await resolver.updateCurrentUser(context, { timezone: 'Europe/London' });

    expect(userService.update).toHaveBeenCalledWith({ userId: OWNER }, OWNER, { timezone: 'Europe/London' });
  });

  it('writes the timezone and the time format together in one update', async () => {
    const { resolver, userService, context } = build({
      userService: {
        update: jest.fn().mockResolvedValue(makeUser({ timezone: 'Asia/Tokyo', timeFormat: 'h23' })),
      },
    });

    const result = await resolver.updateCurrentUser(context, {
      timezone: 'Asia/Tokyo',
      timeFormat: TimeFormatEnum.h23,
    });

    expect(userService.update).toHaveBeenCalledTimes(1);
    expect(userService.update).toHaveBeenCalledWith({ userId: OWNER }, OWNER, {
      timezone: 'Asia/Tokyo',
      timeFormat: 'h23',
    });
    expect(result).toMatchObject({ timezone: 'Asia/Tokyo', timeFormat: 'h23' });
  });

  it('does not write a valid time format when the timezone in the same input is invalid', async () => {
    const { resolver, userService, context } = build();

    await expect(
      resolver.updateCurrentUser(context, { timezone: 'Mars/Olympus_Mons', timeFormat: TimeFormatEnum.h12 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(userService.update).not.toHaveBeenCalled();
  });

  it('reads the user back without writing when the input names nothing', async () => {
    const { resolver, userService, context } = build({
      userService: { findById: jest.fn().mockResolvedValue(makeUser({ timeFormat: 'h12' })) },
    });

    const result = await resolver.updateCurrentUser(context, {});

    expect(userService.update).not.toHaveBeenCalled();
    expect(result?.timeFormat).toBe('h12');
  });
});

describe('UserType.timeFormat', () => {
  it.each<TimeFormat>(['auto', 'h12', 'h23'])('exposes a stored %s as it is', (timeFormat) => {
    expect(UserType.toType(makeUser({ timeFormat })).timeFormat).toBe(timeFormat);
  });

  it('offers exactly the values the column accepts', () => {
    // The GraphQL enum and the domain list are two spellings of one CHECK constraint; a value
    // added to one and not the other would either be unreachable or a 500 on save.
    expect(Object.values(TimeFormatEnum)).toEqual([...TIME_FORMATS]);
  });
});

/**
 * The resolver trusts GraphQL to have refused any string outside the enum before it runs — that is
 * why it only has to handle null. This pins that trust to the schema the web app's codegen reads:
 * if `timeFormat` ever regressed to a free `String`, these documents would start validating.
 */
describe('UpdateCurrentUserInput.timeFormat in the generated schema', () => {
  const schema = buildSchema(
    readFileSync(join(__dirname, '..', '..', '__generated__', 'schema.graphql'), 'utf8'),
  );

  const errorsFor = (value: string) =>
    validate(schema, parse(`mutation { updateCurrentUser(input: { timeFormat: ${value} }) { timeFormat } }`));

  it.each(TIME_FORMATS)('accepts %s', (value) => {
    expect(errorsFor(value)).toEqual([]);
  });

  it.each(['h24', 'H23', '"h12"', 'twelve'])('rejects %s before any resolver runs', (value) => {
    expect(errorsFor(value)).not.toEqual([]);
  });
});
