import { describe, expect, it } from 'vitest';

import { appLabel } from './appLabel';

describe('appLabel', () => {
  it('names the apps it knows', () => {
    expect(appLabel('app:ci-openclaw:ci-marketplace')).toBe('OpenClaw');
    expect(appLabel('app:ci-hermes:ci-marketplace')).toBe('Hermes');
    expect(appLabel('app:ci-mentra:ci-marketplace')).toBe('Mentra glasses');
    expect(appLabel('app:ci-ha-voice:ci-marketplace')).toBe('Home Assistant Voice');
  });

  it('falls back to the slug, so a newly installed app is nameable the day it ships', () => {
    // The fallback is the load-bearing half, not the map.
    expect(appLabel('app:ci-newthing:ci-marketplace')).toBe('ci-newthing');
  });

  it('passes through anything that is not an app urn rather than inventing a slug', () => {
    expect(appLabel('some-key-name')).toBe('some-key-name');
  });

  it('is null-in-null-out, because not every action has an app behind it', () => {
    // Callers render null as "You". A row reading "OpenClaw" when it was the
    // owner's own trust dial would be a lie about provenance.
    expect(appLabel(null)).toBeNull();
    expect(appLabel(undefined)).toBeNull();
    expect(appLabel('')).toBeNull();
  });
});
