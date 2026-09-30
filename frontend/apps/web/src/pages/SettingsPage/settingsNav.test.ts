import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SETTINGS_SECTIONS, settingsPathToProfile, visibleSettingsSections } from './settingsNav';

const isIosPlatform = vi.hoisted(() => vi.fn(() => false));
const isNativePlatform = vi.hoisted(() => vi.fn(() => false));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  isIosPlatform: () => isIosPlatform(),
  isNativePlatform: () => isNativePlatform(),
}));

describe('settingsPathToProfile', () => {
  it('sends the settings root to the Self settings hub', () => {
    expect(settingsPathToProfile('/settings')).toBe('/self/settings');
    expect(settingsPathToProfile('/settings/')).toBe('/self/settings');
  });

  it('keeps the section on the Self settings page', () => {
    expect(settingsPathToProfile('/settings/appearance')).toBe('/self/settings/appearance');
    expect(settingsPathToProfile('/settings/account')).toBe('/self/settings/account');
  });
});

describe('SETTINGS_SECTIONS', () => {
  beforeEach(() => {
    isIosPlatform.mockReturnValue(false);
    isNativePlatform.mockReturnValue(false);
  });

  it('starts with appearance', () => {
    expect(SETTINGS_SECTIONS[0]?.id).toBe('appearance');
  });

  it('hides Safari off iOS and shows it on the Memory iPhone app', () => {
    expect(visibleSettingsSections().some((section) => section.id === 'safari')).toBe(false);
    isIosPlatform.mockReturnValue(true);
    expect(visibleSettingsSections().some((section) => section.id === 'safari')).toBe(true);
  });

  it('offers the on-device model only inside a native shell', () => {
    expect(visibleSettingsSections().some((section) => section.id === 'on-device')).toBe(false);
    isNativePlatform.mockReturnValue(true);
    expect(visibleSettingsSections().some((section) => section.id === 'on-device')).toBe(true);
  });

  it('no longer lists about-you or account — they moved to the Self page', () => {
    expect(visibleSettingsSections().some((section) => section.id === 'about-you')).toBe(false);
    expect(visibleSettingsSections().some((section) => section.id === 'account')).toBe(false);
  });
});
