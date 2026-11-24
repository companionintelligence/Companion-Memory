import { BadRequestException } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';

import { GlobalUID } from '../types/GlobalUID';

import { PersonResolver } from './PersonResolver';

const USER = '00000000-0000-4000-8000-00000000000a';
const PERSON = '00000000-0000-4000-8000-0000000000b1';

/**
 * `addPersonIdentifier` when the shared rule refuses the value.
 *
 * The identifier service returns null for anything that does not normalize,
 * and a phone carrying an extension is now one of those: its last ten digits
 * run the office line and the extension together into somebody else's number.
 * Unlike a digit-less "phone", it is a real number the person may reasonably
 * try to save, so it gets a message that says what is wrong with it.
 */
function makeResolver() {
  const entityIdentifierService = { addForEntity: jest.fn(async () => null) };
  // Nothing else is reached before the refusal.
  const unused = {} as never;

  const resolver = new PersonResolver(
    unused,
    unused,
    unused,
    unused,
    unused,
    entityIdentifierService as never,
    unused,
    unused,
    unused,
    unused,
  );

  return { resolver, entityIdentifierService };
}

const context = { userId: USER } as RequestContext;

describe('PersonResolver.addPersonIdentifier', () => {
  it('names the extension when a phone is refused for carrying one', async () => {
    const { resolver, entityIdentifierService } = makeResolver();

    const attempt = resolver.addPersonIdentifier(context, {
      personId: GlobalUID.encode('person', PERSON),
      kind: 'phone',
      value: '(212) 555-0147;229',
    });

    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt).rejects.toThrow(/includes an extension/);
    expect(entityIdentifierService.addForEntity).toHaveBeenCalledWith(
      USER,
      PERSON,
      'phone',
      '(212) 555-0147;229',
      undefined,
    );
  });

  it('keeps the generic message for a value that is not a number at all', async () => {
    const { resolver } = makeResolver();

    await expect(
      resolver.addPersonIdentifier(context, {
        personId: GlobalUID.encode('person', PERSON),
        kind: 'phone',
        value: 'no digits here',
      }),
    ).rejects.toThrow('"no digits here" does not normalize to a usable phone');
  });
});
