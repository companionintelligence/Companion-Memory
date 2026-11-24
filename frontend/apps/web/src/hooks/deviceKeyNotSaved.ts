import { isNativePlatform } from '@ci/common';

const DESKTOP_MESSAGE =
  "This device's keyring would not save your sign-in, so it was not kept. Set up or unlock the system keyring and try again, or use email and password instead.";

// A phone has no keyring to set up. Its email and password sign-in saves a key in the same store
// too, so neither of the desktop's suggestions would help there.
const PHONE_MESSAGE =
  "This phone's secure storage would not save your sign-in, so it was not kept. Try again, or restart the phone if it keeps happening.";

/**
 * The device's keystore (the OS keychain on desktop, the Keychain or Keystore on a phone) refused
 * the key a sign-in had just made. The key is given back on the server before this is thrown, so
 * the person can try again without leaving one behind. That is best effort: a key the appliance
 * did not take back is still listed under Settings > API keys. Its message is shown as is, by the
 * desktop sign-in screen, the login page and the phone's connect screens.
 */
export class DeviceKeyNotSavedError extends Error {
  constructor(cause: unknown) {
    super(isNativePlatform() ? PHONE_MESSAGE : DESKTOP_MESSAGE, { cause });
    this.name = 'DeviceKeyNotSavedError';
  }
}
