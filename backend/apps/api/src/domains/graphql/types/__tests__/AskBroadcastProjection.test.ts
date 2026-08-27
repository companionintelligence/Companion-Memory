import { AskBroadcastType, AskType } from '../AskType';

const ASKER = 'asker-1';
const RESPONDER = 'responder-1';

function ask(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-0000000000a1',
    askerUserId: ASKER,
    responderUserId: RESPONDER,
    peerLinkId: null,
    direction: 'local',
    broadcastId: '00000000-0000-0000-0000-0000000000b1',
    query: { queryType: 'content', prompt: 'reunion photos' },
    status: 'delivered',
    consentBasis: 'grant-1',
    disclosureCeiling: null,
    channelKeyThumbprint: null,
    channelVerifiedAt: null,
    channelCovered: null,
    createdAt: new Date('2026-08-26T12:00:00.000Z'),
    updatedAt: new Date('2026-08-26T12:00:00.000Z'),
    expiresAt: null,
    ...overrides,
  } as never;
}

/**
 * ═══ WHO ELSE WAS ASKED IS THE ASKER'S BUSINESS ═══
 *
 * A broadcast correlates several people's asks. Telling a RESPONDER that their
 * ask belongs to one would tell them the asker put the same question to others
 * — a fact about the asker's relationships, and a third-party disclosure nobody
 * consented to. It is the same shape as the peer handle and the decline oracle
 * this domain closes elsewhere, pointed the other way from `consentBasis`.
 */
describe('AskType.broadcastId — asker-only', () => {
  it('is returned to the asker', () => {
    expect(AskType.toType(ask(), ASKER).broadcastId).toBe('00000000-0000-0000-0000-0000000000b1');
  });

  it('is WITHHELD from the responder, who would otherwise learn others were asked', () => {
    expect(AskType.toType(ask(), RESPONDER).broadcastId).toBeNull();
  });

  it('is withheld from a third party', () => {
    expect(AskType.toType(ask(), 'nobody').broadcastId).toBeNull();
  });

  /**
   * An omitted viewer must land on the SAFE projection, never the disclosing
   * one — the same rule `consentBasis` follows in the other direction.
   */
  it('is withheld when no viewer is supplied at all', () => {
    expect(AskType.toType(ask()).broadcastId).toBeNull();
  });

  it('does not leak through the responder-only fields either', () => {
    // Sanity: the two asymmetric fields point opposite ways, and neither viewer
    // gets both.
    const asAsker = AskType.toType(ask(), ASKER);
    const asResponder = AskType.toType(ask(), RESPONDER);

    expect(asAsker.broadcastId).not.toBeNull();
    expect(asAsker.consentBasis).toBeNull();
    expect(asResponder.broadcastId).toBeNull();
    expect(asResponder.consentBasis).toBe('grant-1');
  });
});

describe('AskBroadcastType.toType — the aggregate', () => {
  const broadcast = {
    id: '00000000-0000-0000-0000-0000000000b1',
    askerUserId: ASKER,
    query: { queryType: 'content', prompt: 'reunion photos' },
    createdAt: new Date('2026-08-26T12:00:00.000Z'),
    expiresAt: null,
  } as never;

  it('counts recipients and answers', () => {
    const type = AskBroadcastType.toType(broadcast, [
      ask({ status: 'answered' }),
      ask({ status: 'answered' }),
      ask({ status: 'under_review' }),
    ]);

    expect(type).toMatchObject({ recipients: 3, answered: 2, waiting: 1 });
  });

  /**
   * Declined, expired, in-review and never-heard-from are ONE number.
   *
   * Splitting them would hand the asker a per-recipient read on each
   * responder's consent posture — the oracle `askerVisibleStatus` collapses for
   * a single ask. A broadcast must not be a cheaper way to run the same probe
   * N times.
   */
  it('folds every non-answered outcome into one `waiting` count', () => {
    const type = AskBroadcastType.toType(broadcast, [
      ask({ status: 'declined' }),
      ask({ status: 'expired' }),
      ask({ status: 'under_review' }),
      ask({ status: 'delivered' }),
    ]);

    expect(type).toMatchObject({ recipients: 4, answered: 0, waiting: 4 });
  });

  it('reports an empty broadcast without dividing by anything', () => {
    expect(AskBroadcastType.toType(broadcast, [])).toMatchObject({
      recipients: 0,
      answered: 0,
      waiting: 0,
    });
  });
});
