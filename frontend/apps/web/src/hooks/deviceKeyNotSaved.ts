/**
 * The device's keystore (the OS keychain on desktop) refused the key a sign-in had just made. The
 * key was given back on the server, so the person can try again without leaving one behind. Its
 * message is shown as is, by the desktop sign-in screen and the login page alike.
 */
export class DeviceKeyNotSavedError extends Error {
  constructor(cause: unknown) {
    super(
      "This device's keyring would not save your sign-in, so it was not kept. Set up or unlock the system keyring and try again, or use email and password instead.",
      { cause },
    );
    this.name = 'DeviceKeyNotSavedError';
  }
}
