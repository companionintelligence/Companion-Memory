import { describe, expect, it } from 'vitest';

import { filterValueLabel, sourceFilterLabel } from './sourceNames';

describe('filterValueLabel', () => {
  it('capitalises each word and shows underscores as spaces', () => {
    expect(filterValueLabel('amazon_music')).toBe('Amazon Music');
    expect(filterValueLabel('google_maps_places')).toBe('Google Maps Places');
    expect(filterValueLabel('visited')).toBe('Visited');
  });

  it('leaves the rest of a word as it was written', () => {
    expect(filterValueLabel('iOS_backup')).toBe('IOS Backup');
    expect(filterValueLabel('browser-activity')).toBe('Browser-activity');
  });
});

describe('sourceFilterLabel', () => {
  it('spells a brand its own way when only the letter case differs', () => {
    expect(sourceFilterLabel('youtube')).toBe('YouTube');
    expect(sourceFilterLabel('whatsapp')).toBe('WhatsApp');
    expect(sourceFilterLabel('imessage')).toBe('iMessage');
  });

  it('never borrows a badge name that says something else, so no two sources share a label', () => {
    // labelForSource calls these "Photos", "Chrome" and "Reddit".
    expect(sourceFilterLabel('google_photos')).toBe('Google Photos');
    expect(sourceFilterLabel('chromium')).toBe('Chromium');
    expect(sourceFilterLabel('reddit_saved')).toBe('Reddit Saved');
    expect(sourceFilterLabel('reddit')).toBe('Reddit');
  });

  it('falls back to the plain rule for a source it has never heard of', () => {
    expect(sourceFilterLabel('amazon_music')).toBe('Amazon Music');
    expect(sourceFilterLabel('dropbox')).toBe('Dropbox');
  });
});
