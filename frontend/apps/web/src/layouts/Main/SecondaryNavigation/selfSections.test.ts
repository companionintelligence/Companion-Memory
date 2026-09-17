import { describe, expect, it } from 'vitest';

import { isSelfPath, isSettingsPath, settingsNavTarget } from './selfSections';

const location = {
  pathname: '/plan',
  search: '',
  hash: '',
  state: null,
  key: 'abc',
};

describe('settingsNavTarget', () => {
  it('returns nothing until the device layout is known, to avoid a flash of the wrong destination', () => {
    expect(settingsNavTarget(undefined, location)).toBeNull();
  });

  it('opens the overlay dialog on desktop, carrying the current page as its backgroundLocation', () => {
    expect(settingsNavTarget(false, location)).toEqual({
      to: '/settings/appearance',
      state: { backgroundLocation: location },
    });
  });

  it('walks to the real settings page on mobile, not the desktop overlay route', () => {
    expect(settingsNavTarget(true, location)).toEqual({ to: '/self/settings' });
  });
});

describe('isSettingsPath', () => {
  it.each(['/self/settings', '/self/settings/appearance', '/settings', '/settings/appearance'])(
    'treats %s as Settings',
    (path) => {
      expect(isSettingsPath(path)).toBe(true);
      expect(isSelfPath(path)).toBe(true);
    },
  );

  it('does not treat other Self pages as Settings', () => {
    expect(isSettingsPath('/self')).toBe(false);
    expect(isSettingsPath('/self/stats')).toBe(false);
  });
});
