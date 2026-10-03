import { setApiBaseUrl, setApiKey } from '@ci/common';

/** The Memory the simulated phone is paired with. */
export const NATIVE_MEMORY_ORIGIN = 'https://memory.example';

type CapacitorWindow = { Capacitor?: { isNativePlatform: () => boolean } };

/**
 * Put the app in the state the bundled iOS/Android shell is in: `window.Capacitor`
 * reports a native platform and a Memory server has been paired.
 *
 * jsdom's own page origin stays `http://localhost:3000`, which is NOT
 * `capacitor://localhost` — so a test that asserts the Memory origin shows up in
 * a URL is exactly the proof that nothing fell back to the page's origin.
 *
 * Returns the function that undoes it; call that from `afterEach`, because both
 * the Capacitor stub and the API base are process-wide.
 */
export function enterNativeShell(options: { origin?: string; apiKey?: string } = {}): () => void {
  const { origin = NATIVE_MEMORY_ORIGIN, apiKey } = options;

  (window as unknown as CapacitorWindow).Capacitor = { isNativePlatform: () => true };
  setApiBaseUrl(origin);

  if (apiKey) {
    setApiKey(apiKey);
  }

  return () => {
    delete (window as unknown as CapacitorWindow).Capacitor;
    setApiBaseUrl('');
    setApiKey(null);
  };
}
