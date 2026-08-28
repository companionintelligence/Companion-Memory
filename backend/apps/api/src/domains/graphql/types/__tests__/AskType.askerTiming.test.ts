import { type Ask } from '@ci/domains/asks';

import { AskType, askerVisibleUpdatedAt } from '../AskType';

/**
 * ═══ THE TIMING CHANNEL #2216 LEFT OPEN ═══
 *
 * #2216 collapsed `AskType.status` so the asker could no longer read the
 * responder's standing-grant posture off their own ask. `updatedAt` was left
 * alone, and it carries the same signal in a different unit: `ci.asks.updated_at`
 * is an `@UpdateDateColumn`, so it moves on every responder-side write and on
 * nothing else. All three submit-time postures write once at submit, so the
 * differential is not at creation — it is the LATER mutation, which exists only
 * when a human on the other side acted.
 *
 * These assert the projection, not the resolver, for the same reason the status
 * cut was made there: `createAsk`, `ask(id)` and `askOutbox` all hand the asker
 * the same row, so one gate covers every read path.
 */

const RESPONDER = 'responder-1';
const ASKER = 'asker-1';

const CREATED = new Date('2026-08-20T09:00:00Z');
/** Four hours later: the responder read the inbox and acted. */
const TOUCHED = new Date('2026-08-20T13:00:00Z');

function fakeAsk(overrides: Partial<Ask> = {}): Ask {
  return {
    id: 'ask-1',
    askerUserId: ASKER,
    peerLinkId: null,
    direction: 'local',
    responderUserId: RESPONDER,
    query: { queryType: 'photos', prompt: 'do you have photos of us?' },
    status: 'delivered',
    consentBasis: null,
    disclosureCeiling: null,
    createdAt: CREATED,
    updatedAt: TOUCHED,
    expiresAt: null,
    ...overrides,
  } as Ask;
}

describe('AskType — the asker cannot observe responder activity through the clock', () => {
  it.each(['delivered', 'under_review', 'answering', 'declined', 'expired'] as const)(
    'pins updatedAt to createdAt for the asker on a %s ask',
    (status) => {
      expect(AskType.toType(fakeAsk({ status }), ASKER).updatedAt).toEqual(CREATED);
    },
  );

  it('pins it for the answered ask too — the answer carries its own timestamp', () => {
    // `answered` is the one status the asker still sees, so leaving the real
    // `updatedAt` here would be defensible; it is pinned anyway because
    // `AskAnswerType.createdAt` already gives the asker the moment they are
    // entitled to, and a conditional would be a second thing to get wrong.
    expect(AskType.toType(fakeAsk({ status: 'answered' }), ASKER).updatedAt).toEqual(CREATED);
  });

  it('a caller that forgets to say who is looking gets the pinned value', () => {
    // Same invariant as `consentBasis` and `status`: an omitted viewer argument
    // must never be the disclosing case.
    expect(AskType.toType(fakeAsk()).updatedAt).toEqual(CREATED);
  });

  it('pins it for the OUTBOUND asker, whose responder is a remote peer', () => {
    // An outbound ask has no local responder at all, so `isResponder` is false
    // for the local owner — exactly as `askerVisibleStatus` already assumes.
    // The peer answering is still responder activity.
    const outbound = fakeAsk({ direction: 'outbound', responderUserId: null, peerLinkId: 'link-1' });

    expect(AskType.toType(outbound, ASKER).updatedAt).toEqual(CREATED);
  });

  it('the shape of the movement is what leaks — two asks touched differently look identical', () => {
    // The oracle is not the absolute value, it is the CONTRAST. A block grant
    // auto-declines within milliseconds of submit; an ask a person read hours
    // later moves hours later; an untouched ask never moves at all. Three
    // distinguishable timings re-derive the grant posture that #2216 removed
    // from `status`, so all three must project the same.
    const autoDenied = fakeAsk({ status: 'declined', updatedAt: new Date(CREATED.getTime() + 40) });
    const humanRead = fakeAsk({ status: 'under_review', updatedAt: TOUCHED });
    const untouched = fakeAsk({ status: 'delivered', updatedAt: CREATED });

    const seen = [autoDenied, humanRead, untouched].map((ask) => AskType.toType(ask, ASKER).updatedAt);

    expect(new Set(seen.map((d) => d.toISOString())).size).toBe(1);
  });

  it('keeps the RESPONDER’s own clock intact — it is their record', () => {
    expect(AskType.toType(fakeAsk({ status: 'answering' }), RESPONDER).updatedAt).toEqual(TOUCHED);
  });

  it('does not disturb createdAt or expiresAt, which the asker legitimately holds', () => {
    const expires = new Date('2026-08-21T09:00:00Z');
    const projected = AskType.toType(fakeAsk({ expiresAt: expires }), ASKER);

    expect(projected.createdAt).toEqual(CREATED);
    expect(projected.expiresAt).toEqual(expires);
  });
});

describe('askerVisibleUpdatedAt', () => {
  it('is pure and total: it returns the ask’s own creation instant', () => {
    expect(askerVisibleUpdatedAt({ createdAt: CREATED })).toEqual(CREATED);
  });
});
