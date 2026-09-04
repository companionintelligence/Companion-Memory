export const ONBOARDING_STEP_KEYS = [
  'intro',
  'identity',
  'time-and-place',
  'focus-areas',
  'people',
  'preferences-food',
  'preferences-movie',
  'preferences-activity',
  'connect-source',
  'import-archives',
  'trust-dial',
  'run-first-sync',
] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEP_KEYS)[number];

/** Set before OAuth top-level navigation; cleared when onboarding restores the connect step. */
export const ONBOARDING_OAUTH_RESUME_KEY = 'onboarding-resume';

export const CHROME_EXTENSION_URL =
  'https://chromewebstore.google.com/detail/companion-intelligence/bcocflgkdeimninckpmdifcniajoneih?authuser=3&hl=en';

export const FIREFOX_EXTENSION_URL = 'https://addons.mozilla.org/en-US/firefox/addon/companion-intelligence/';

export const CI_DOWNLOAD_URL = 'https://ci.computer/download';

export const CAPTURE_DOWNLOAD_URL = 'https://ci.computer/download#capture';

export const BROWSER_TIMEZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

export function buildOnboardingStepKeys(options: {
  needsIdentity: boolean;
  preferenceStepsEnabled: boolean;
  importEnabled?: boolean;
}): OnboardingStepKey[] {
  const keys: OnboardingStepKey[] = ['intro'];

  if (options.needsIdentity) {
    keys.push('identity');
  }

  keys.push('time-and-place', 'focus-areas', 'people');

  if (options.preferenceStepsEnabled) {
    keys.push('preferences-food', 'preferences-movie', 'preferences-activity');
  }

  // `import-archives` sits directly after `connect-source`: both answer "where
  // does my memory come from", and the order is deliberate — connectors are the
  // low-effort default, an export is the high-value one someone may already
  // have downloaded. Always present and always skippable, like every other
  // step; it is gated by the same `import.page` feature flag as /import, so an
  // appliance with importing turned off does not offer a step that leads
  // nowhere.
  keys.push('connect-source');

  if (options.importEnabled) {
    keys.push('import-archives');
  }

  keys.push('trust-dial', 'run-first-sync');

  return keys;
}
