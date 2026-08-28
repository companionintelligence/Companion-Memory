import { describe, expect, it } from 'vitest';

import {
  grantLabel,
  itemLabel,
  knownAskerLabel,
  partyAvatar,
  partyLabel,
  peerLinksByHandle,
  scopeSummary,
  searchBreadthNote,
} from './askBinding';

describe('searchBreadthNote', () => {
  /**
   * The executor maps a handful of data classes onto entity-type filters and
   * runs UNFILTERED for everything else. The card must never let the owner read
   * the declared class as a narrower scope than the search that runs.
   */
  it('warns that an unmapped class searches everything', () => {
    const note = searchBreadthNote({ dataClass: 'location' });

    expect(note).toMatch(/every kind of thing in your memory/i);
    expect(note).toContain('location');
  });

  it('says so when the ask names no class at all', () => {
    expect(searchBreadthNote({})).toMatch(/every kind of thing in your memory/i);
    expect(searchBreadthNote({ dataClass: null })).toMatch(/every kind of thing in your memory/i);
  });

  it('never promises a narrowing, even for a class the backend does map', () => {
    // `photos` IS in the executor's hint table today. The note still declines to
    // assert the narrowing, because a mirrored copy of that table here would go
    // stale in the one direction that matters — claiming narrow while the search
    // widened. Over-stating breadth is safe; under-stating it never is.
    expect(searchBreadthNote({ dataClass: 'photos' })).toMatch(/every kind of thing in your memory/i);
  });
});

describe('opaque id presentation', () => {
  it('marks a shortened id as a truncation rather than as a name', () => {
    // "Peer __devon" read as corrupted text; the ellipsis says characters
    // precede it, which is what makes the same fragment read as an id.
    expect(partyLabel(null, 'user_globaluid__devon')).toBe('Peer …_devon');
    expect(partyLabel(null, 'globaluid-abc123')).toBe('Peer …abc123');
    expect(itemLabel({ id: 'file-globaluid-a3f2b1', type: 'photo' })).toBe('photo …a3f2b1');
  });

  it('keeps the fragment a faithful suffix, punctuation and all', () => {
    // Nothing is trimmed off the front of the slice. Dropping the leading `_`
    // would both shorten the discriminating tail and turn "…_devon" into
    // "…devon", which reads like a name — the one thing this must never do.
    expect(partyLabel(null, 'xxxxr_maya')).toBe('Peer …r_maya');
    expect(partyLabel(null, 'aaaaaabbbbbb')).toBe('Peer …bbbbbb');
    expect(partyLabel(null, 'user_globaluid__devon')).toContain('_devon');
  });

  it('prefers a real handle, and admits when there is nothing at all', () => {
    expect(partyLabel('maya@example.social', 'globaluid-abc123')).toBe('maya@example.social');
    expect(partyLabel(null, null)).toBe('Unknown');
  });
});

describe('partyAvatar', () => {
  it('resolves a peer-handled row against myPeerLinks: real display name and photo', () => {
    const links = peerLinksByHandle([
      { peerHandle: 'ada', displayName: 'Ada L.', avatarUrl: '/avatars/ada.png' },
    ]);

    expect(partyAvatar('ada', 'globaluid-abc123', links)).toEqual({
      name: 'Ada L.',
      avatarUrl: '/avatars/ada.png',
    });
  });

  it('falls back to the handle itself when the link has no display name', () => {
    const links = peerLinksByHandle([{ peerHandle: 'ada', displayName: null, avatarUrl: null }]);

    expect(partyAvatar('ada', null, links)).toEqual({ name: 'ada', avatarUrl: null });
  });

  it('falls back to partyLabel, with no photo, for a handle the roster has not resolved', () => {
    const links = peerLinksByHandle([]);

    expect(partyAvatar('ada', null, links)).toEqual({ name: 'ada', avatarUrl: null });
  });

  it('falls back to the opaque id fragment for a local counterparty — never invents a name', () => {
    const links = peerLinksByHandle([{ peerHandle: 'ada', displayName: 'Ada L.', avatarUrl: '/a.png' }]);

    expect(partyAvatar(null, 'globaluid-abc123', links)).toEqual({
      name: 'Peer …abc123',
      avatarUrl: null,
    });
  });
});

describe('scopeSummary and grantLabel', () => {
  it('renders exactly what the wire carries', () => {
    expect(scopeSummary({ queryType: 'photos', dataClass: 'photos' })).toBe('photos · photos');
    expect(scopeSummary({ queryType: 'availability' })).toBe('availability');
    expect(grantLabel('photos', null)).toBe('photos · all classes');
  });

  it('reports the only trust fact on the wire without inventing a tier', () => {
    expect(knownAskerLabel('grant-1')).toBe('known contact');
    expect(knownAskerLabel(null)).toBe('no standing grant');
  });
});
