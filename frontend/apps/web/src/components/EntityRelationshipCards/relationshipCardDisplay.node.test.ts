import { describe, expect, it } from 'vitest';

import {
  filterDisplayTags,
  formatCardWhen,
  formatNeighborKind,
  formatRelationshipPhrase,
  isTechnicalPropertyKey,
  pickCardSummary,
} from './relationshipCardDisplay';

describe('formatNeighborKind', () => {
  it('title-cases a graph entity type instead of shouting PERSON', () => {
    expect(formatNeighborKind('PERSON')).toBe('Person');
    expect(formatNeighborKind('place')).toBe('Place');
  });

  it('calls a communication a Message, or the channel when we have one', () => {
    expect(formatNeighborKind('COMMUNICATION')).toBe('Message');
    expect(formatNeighborKind('communication', { type: 'email' })).toBe('Email');
    expect(formatNeighborKind('communication', { type: 'imessage' })).toBe('iMessage');
  });
});

describe('formatRelationshipPhrase', () => {
  it('reads mail from the page the user is on, not the raw enum', () => {
    expect(formatRelationshipPhrase('EMAILED', { focusIsSource: false })).toBe('Emailed you');
    expect(formatRelationshipPhrase('EMAILED', { focusIsSource: true })).toBe('You emailed');
    expect(formatRelationshipPhrase('RECEIVED_EMAIL_FROM', { focusIsSource: true })).toBe('Emailed you');
  });

  it('uses normalized_from when the live type was collapsed to a generic edge', () => {
    expect(
      formatRelationshipPhrase('ASSOCIATED_WITH', {
        focusIsSource: false,
        relationshipProperties: { normalized_from: 'RECEIVED_EMAIL_FROM' },
      }),
    ).toBe('You emailed');
  });

  it('hides leftover associated-with edges that have no original type', () => {
    expect(formatRelationshipPhrase('ASSOCIATED_WITH', { focusIsSource: true })).toBeNull();
  });

  it('falls back to a title-cased enum for types we have not curated', () => {
    expect(formatRelationshipPhrase('SITS_NEAR', { focusIsSource: true })).toBe('Sits Near');
  });
});

describe('pickCardSummary', () => {
  it('prefers a description that is not just the title repeated', () => {
    expect(
      pickCardSummary({
        name: 'bennett',
        description: 'Sells records on Reverb',
      }),
    ).toBe('Sells records on Reverb');
  });

  it('skips a description that duplicates the name', () => {
    expect(
      pickCardSummary({
        name: 'Order complete: Reverb',
        description: 'Order complete: Reverb',
        entityProperties: { preview: 'Your vinyl shipped today' },
      }),
    ).toBe('Your vinyl shipped today');
  });

  it('returns nothing when there is no human summary', () => {
    expect(pickCardSummary({ name: 'bennett', description: null })).toBeNull();
  });
});

describe('filterDisplayTags', () => {
  it('drops Gmail system labels and the entity type repeated as a tag', () => {
    expect(
      filterDisplayTags(
        ['COMMUNICATION', 'IMPORTANT', 'INBOX', 'CATEGORY_PERSONAL', 'vinyl'],
        'COMMUNICATION',
      ),
    ).toEqual(['vinyl']);
  });
});

describe('isTechnicalPropertyKey', () => {
  it('treats connection and normalize bookkeeping as technical', () => {
    expect(isTechnicalPropertyKey('connection_id')).toBe(true);
    expect(isTechnicalPropertyKey('normalized_from')).toBe(true);
    expect(isTechnicalPropertyKey('role')).toBe(false);
  });
});

describe('formatCardWhen', () => {
  const now = new Date('2026-08-27T18:00:00');

  it('returns a short date for another day this year', () => {
    expect(formatCardWhen(Date.parse('2026-03-04T12:00:00'), now)).toBe('Mar 4');
  });

  it('returns null when there is no recency', () => {
    expect(formatCardWhen(0, now)).toBeNull();
  });
});
