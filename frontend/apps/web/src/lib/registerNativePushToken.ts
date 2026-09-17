/**
 * Register this phone's APNs/FCM token with the Memory Server. The appliance
 * stores it on `ci.devices.push_token` and, when `PORTAL_PUSH_RELAY_URL` is set,
 * forwards it to Portal. The LAN box must not hold the app's APNs key.
 *
 * Reached through `window.Capacitor.Plugins` so the web bundle never imports
 * `@capacitor/push-notifications`. Missing plugin or denied permission is a no-op.
 *
 * Android remote push uses FCM (Google's transport). That needs
 * `google-services.json` so FirebaseApp initializes at startup. Calling
 * `PushNotifications.register()` without it throws on the CapacitorPlugins
 * thread and kills the process — JS try/catch cannot catch it. Probe via the
 * native `FcmStatus` plugin and skip Android registration until FCM is wired.
 * iOS (APNs) and local notifications are unaffected.
 */
import { apiKeyHeaders, buildApiUrl, isNativePlatform } from '@ci/common';

const DEVICE_ID_KEY = 'ci.native.deviceId';

type PushPlugin = {
  requestPermissions: () => Promise<{ receive: string }>;
  register: () => Promise<void>;
  addListener: (
    event: 'registration',
    cb: (token: { value: string }) => void,
  ) => Promise<{ remove: () => void }>;
};

type FcmStatusPlugin = {
  isConfigured: () => Promise<{ configured: boolean }>;
};

type CapacitorGlobals = {
  Capacitor?: {
    Plugins?: {
      PushNotifications?: PushPlugin;
      FcmStatus?: FcmStatusPlugin;
    };
    getPlatform?: () => string;
  };
};

function capacitor(): CapacitorGlobals['Capacitor'] {
  return (window as unknown as CapacitorGlobals).Capacitor;
}

function pushPlugin(): PushPlugin | undefined {
  return capacitor()?.Plugins?.PushNotifications;
}

function nativePlatform(): 'ios' | 'android' {
  return capacitor()?.getPlatform?.() === 'ios' ? 'ios' : 'android';
}

/**
 * Android-only: true when FirebaseApp is initialized (google-services.json present).
 * iOS always returns true — APNs does not use Firebase.
 */
async function isRemotePushTransportReady(): Promise<boolean> {
  if (nativePlatform() !== 'android') {
    return true;
  }

  const status = capacitor()?.Plugins?.FcmStatus;

  if (!status?.isConfigured) {
    // Older APKs without the probe must not call register() — that path crashes.
    return false;
  }

  try {
    const result = await status.isConfigured();

    return result.configured === true;
  } catch {
    return false;
  }
}

function readDeviceId(): string | null {
  try {
    return window.localStorage.getItem(DEVICE_ID_KEY);
  } catch {
    return null;
  }
}

function writeDeviceId(id: string): void {
  try {
    window.localStorage.setItem(DEVICE_ID_KEY, id);
  } catch {
    /* session-only */
  }
}

export async function registerNativePushToken(): Promise<void> {
  if (!isNativePlatform()) {
    return;
  }

  const push = pushPlugin();

  if (!push) {
    return;
  }

  if (!(await isRemotePushTransportReady())) {
    return;
  }

  try {
    const permission = await push.requestPermissions();

    if (permission.receive !== 'granted') {
      return;
    }

    let tokenWrite: Promise<void> = Promise.resolve();
    const handle = await push.addListener('registration', (token) => {
      tokenWrite = upsertDeviceToken(token.value).finally(() => {
        void handle.remove();
      });
    });

    await push.register();
    await tokenWrite;
  } catch {
    // Local notifications still work. Remote push needs Portal relay + store certs.
  }
}

async function upsertDeviceToken(pushToken: string): Promise<void> {
  const existingId = readDeviceId();
  const platform = nativePlatform();
  const headers = {
    'Content-Type': 'application/json',
    ...apiKeyHeaders(),
  };

  if (existingId) {
    await fetch(buildApiUrl(`/api/devices/${existingId}`), {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ push_token: pushToken }),
    });

    return;
  }

  const response = await fetch(buildApiUrl('/api/devices'), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      device_type: 'smartphone',
      platform,
      device_name: platform === 'ios' ? 'iPhone' : 'Android',
      push_token: pushToken,
      is_active: true,
    }),
  });

  if (!response.ok) {
    return;
  }

  const body = (await response.json()) as { device_id?: string };

  if (body.device_id) {
    writeDeviceId(body.device_id);
  }
}
