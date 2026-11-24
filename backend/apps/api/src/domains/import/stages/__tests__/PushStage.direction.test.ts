import type { CanonicalRecord } from '../../push/canonical';
import { directionAfterSender } from '../PushStage';

/**
 * A mail with no delivery headers is read as the owner's sent copy by the
 * parser (email_direction.ts). Once the push knows the sender, a header-less
 * mail from somebody else to the owner is inbound. Nothing else moves.
 */
const SELF = 'self-person';
const STRANGER = 'stranger-person';
const FRIEND = 'friend-person';

function mail(basis: string | undefined, from = '"He Tester" <stranger@example.net>'): CanonicalRecord {
  return {
    metadata: { From: from, ...(basis ? { DirectionBasis: basis } : {}) },
  } as unknown as CanonicalRecord;
}

const toOwner = new Map([
  ['from', [STRANGER]],
  ['to', [SELF]],
]);

describe('directionAfterSender', () => {
  it('turns a header-less mail from somebody else to the owner inbound', () => {
    expect(directionAfterSender('outbound', mail('no_delivery_trace'), toOwner, STRANGER, SELF)).toBe(
      'inbound',
    );
  });

  it('counts the owner on Cc as a recipient too', () => {
    const cc = new Map([
      ['from', [STRANGER]],
      ['to', [FRIEND]],
      ['cc', [SELF]],
    ]);

    expect(directionAfterSender('outbound', mail('no_delivery_trace'), cc, STRANGER, SELF)).toBe('inbound');
  });

  it('leaves the Gmail Sent label, and any other basis, as the parser read it', () => {
    expect(directionAfterSender('outbound', mail('sent_label'), toOwner, STRANGER, SELF)).toBe('outbound');
    expect(directionAfterSender('outbound', mail(undefined), toOwner, STRANGER, SELF)).toBe('outbound');
  });

  it('leaves mail the owner sent as outbound', () => {
    const own = new Map([
      ['from', [SELF]],
      ['to', [FRIEND]],
    ]);

    expect(
      directionAfterSender('outbound', mail('no_delivery_trace', 'Me <me@example.com>'), own, SELF, SELF),
    ).toBe('outbound');
  });

  it('leaves mail from an address Memory does not know to a third party as outbound', () => {
    // The owner writing from an alias that is not on their person: the sender
    // resolves to a stranger, but the owner is no recipient.
    const alias = new Map([
      ['from', [STRANGER]],
      ['to', [FRIEND]],
    ]);

    expect(directionAfterSender('outbound', mail('no_delivery_trace'), alias, STRANGER, SELF)).toBe(
      'outbound',
    );
  });

  it('needs an address in From, and a known owner', () => {
    expect(
      directionAfterSender('outbound', mail('no_delivery_trace', 'He Tester'), toOwner, STRANGER, SELF),
    ).toBe('outbound');
    expect(directionAfterSender('outbound', mail('no_delivery_trace'), toOwner, STRANGER, null)).toBe(
      'outbound',
    );
    expect(directionAfterSender('outbound', mail('no_delivery_trace'), toOwner, undefined, SELF)).toBe(
      'outbound',
    );
  });

  it('never turns an inbound mail around', () => {
    expect(directionAfterSender('inbound', mail('no_delivery_trace'), toOwner, STRANGER, SELF)).toBe(
      'inbound',
    );
  });
});
