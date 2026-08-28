import { describe, expect, it } from 'vitest';

import {
  ASK_ARCHETYPES,
  COMPOSER_SHAPES,
  composeRecipients,
  unreachablePeers,
} from './composeRecipients';

const EMPTY = { grants: [], inbox: [], outbox: [] };

describe('composeRecipients', () => {
  it('offers only ids the owner is already looking at on this page', () => {
    const recipients = composeRecipients({
      grants: [{ granteeId: 'g-1', mode: 'auto', active: true, revokedAt: null }],
      inbox: [{ askerId: 'i-1', peerHandle: null }],
      outbox: [{ responderId: 'o-1', peerHandle: null }],
    });

    // The whole design constraint: no user-search endpoint exists, and adding
    // one would hand any signed-in account a roster of everybody on a box that
    // holds one person's entire life.
    expect(recipients.map((r) => r.id)).toEqual(['g-1', 'i-1', 'o-1']);
  });

  it('drops a grantee whose consent the owner has withdrawn', () => {
    const revoked = composeRecipients({
      ...EMPTY,
      grants: [{ granteeId: 'g-1', mode: 'auto', active: true, revokedAt: '2026-08-03T00:00:00.000Z' }],
    });
    const lapsed = composeRecipients({
      ...EMPTY,
      grants: [{ granteeId: 'g-2', mode: 'auto', active: false, revokedAt: null }],
    });

    // "We still have their id" is true and irrelevant. A picker that keeps
    // suggesting a relationship the owner ended is the page arguing with them.
    expect(revoked).toEqual([]);
    expect(lapsed).toEqual([]);
  });

  it('never offers a federated row, whose local id addresses the wrong box', () => {
    const recipients = composeRecipients({
      ...EMPTY,
      inbox: [{ askerId: 'i-1', peerHandle: 'ada' }],
      outbox: [{ responderId: 'o-1', peerHandle: 'ada' }],
    });

    expect(recipients).toEqual([]);
  });

  it('deduplicates a person who appears in several places, keeping the strongest reason', () => {
    const recipients = composeRecipients({
      grants: [{ granteeId: 'same', mode: 'auto', active: true, revokedAt: null }],
      inbox: [{ askerId: 'same', peerHandle: null }],
      outbox: [{ responderId: 'same', peerHandle: null }],
    });

    expect(recipients).toHaveLength(1);
    expect(recipients[0]).toMatchObject({ why: 'you have given them a standing grant', autoAnswers: true });
  });

  it('carries the auto-answer flag even when the grant is not the winning reason', () => {
    // Ordering must not decide whether the asker is told to expect an instant
    // reply; the fact is a property of the person, not of which list won.
    const recipients = composeRecipients({
      grants: [{ granteeId: 'same', mode: 'auto', active: true, revokedAt: null }],
      inbox: [{ askerId: 'same', peerHandle: null }],
      outbox: [],
    });

    expect(recipients[0]?.autoAnswers).toBe(true);
  });

  it('never invents a display name for an opaque id', () => {
    const [recipient] = composeRecipients({
      ...EMPTY,
      inbox: [{ askerId: 'globaluid-abc123', peerHandle: null }],
    });

    // A convincing name on a consent surface is an unearned claim. The label
    // must read as a truncation of an id, which is all it is.
    expect(recipient?.name).toBe('Peer …abc123');
    expect(recipient?.tier).toBe('on this Companion');
    // No photo either — nothing on this schema resolves a local relationship
    // id to a Person's avatar. PersonAvatar still renders a real avatar for
    // this (initials on a deterministic colour), just with no image.
    expect(recipient?.avatarUrl).toBeNull();
  });
});

describe('unreachablePeers', () => {
  const link = (overrides: Record<string, unknown> = {}) => ({
    id: 'peer-link-1',
    peerHandle: 'ada',
    displayName: null,
    trustTier: 'stranger',
    status: 'active',
    revokedAt: null,
    ...overrides,
  });

  it('names the peer WITH its tier, which is the ceiling on what they can be told', () => {
    const [peer] = unreachablePeers([link()]);

    expect(peer).toMatchObject({ name: 'ada', tier: 'Stranger' });
    expect(peer?.reason).toMatch(/access token/i);
  });

  it('carries the linked Person’s avatar through, when the link resolved one', () => {
    const [withPhoto] = unreachablePeers([link({ avatarUrl: '/avatars/ada.png' })]);
    const [withoutPhoto] = unreachablePeers([link()]);

    expect(withPhoto?.avatarUrl).toBe('/avatars/ada.png');
    expect(withoutPhoto?.avatarUrl).toBeNull();
  });

  it('drops an ended relationship rather than explaining its unavailability', () => {
    expect(unreachablePeers([link({ revokedAt: '2026-08-03T00:00:00.000Z' })])).toEqual([]);
    expect(unreachablePeers([link({ status: 'revoked' })])).toEqual([]);
  });
});

describe('COMPOSER_SHAPES', () => {
  // THE assertion on this list. `parseAskQueryType` throws a 400 for anything
  // outside the archetype vocabulary and `createAsk` runs every ask through it,
  // so a shape naming a non-archetype is not a wide ask — it is a Send button
  // that always fails. Two of the four shipped shapes ('existence', 'photos')
  // were exactly that, and the previous version of this test asserted the
  // broken values literally, which is why nothing caught it: every other test
  // on this page mocks the mutation and never reaches the resolver.
  //
  // Written as a membership check rather than a literal list on purpose. A
  // literal list re-pins whatever is currently there; this one fails for any
  // future shape that leaves the vocabulary, which is the actual invariant.
  it('names only query types the server will accept', () => {
    for (const shape of COMPOSER_SHAPES) {
      expect(ASK_ARCHETYPES).toContain(shape.queryType);
    }
  });

  it('offers a distinct question shape per entry', () => {
    const ids = COMPOSER_SHAPES.map((shape) => shape.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('states a ceiling on every shape, and never promises a class narrows the search', () => {
    for (const shape of COMPOSER_SHAPES) {
      expect(shape.ceiling.length).toBeGreaterThan(0);
    }

    // `photos` resolves to the whole `file` entity type, and an unrecognised
    // class resolves to no filter at all — so a shape carrying a class must not
    // read as if naming one confined anything.
    const photos = COMPOSER_SHAPES.find((shape) => shape.dataClass === 'photos');

    expect(photos?.ceiling).toMatch(/does not narrow/i);
  });

  // The photos shape rides the `content` archetype, whose declared form is
  // `existence` — a count. It used to ride the unrecognised `photos`, which
  // fell through to `retrieval` and really could return item references, so the
  // old copy promised them. Now it cannot deliver that, and copy that promises
  // more disclosure than the server permits is the same defect as copy that
  // promises less: the owner consents against a description of what happens.
  it('does not promise item references the content archetype cannot return', () => {
    const photos = COMPOSER_SHAPES.find((shape) => shape.dataClass === 'photos');

    expect(photos?.queryType).toBe('content');
    expect(photos?.ceiling).not.toMatch(/references/i);
  });
});
