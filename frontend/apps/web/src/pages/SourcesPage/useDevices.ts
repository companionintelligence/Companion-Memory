import { useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

/**
 * A device this appliance has registered, as `GET /devices` returns it.
 *
 * Browsers register here too — `device_type: 'browser'` — which is why the
 * extension and the desktop app share one path: to the registry they are the
 * same kind of thing, a machine that reports in.
 */
export interface RegisteredDevice {
  readonly device_id: string;
  readonly device_name: string;
  readonly device_type: string;
  readonly platform?: string | null;
  readonly model?: string | null;
  readonly app_version?: string | null;
  readonly os_version?: string | null;
  readonly last_seen: string;
  readonly is_active: boolean;
}

/**
 * Everything that has reported in, newest first.
 *
 * Read-only and best-effort: an unreachable endpoint yields an empty list and
 * the panel simply shows the install galleries, which is what someone with no
 * devices sees anyway.
 */
export function useDevices(): { devices: readonly RegisteredDevice[]; loading: boolean } {
  const [{ authToken, authenticated }] = useAuth();
  const [devices, setDevices] = useState<readonly RegisteredDevice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // `authenticated`, not `authToken`. The latter is the web JWT and is null
    // inside the Capacitor app, whose durable credential is a keystore API key
    // `fetchJson` attaches as `x-api-key` on its own — so this returned before
    // it fetched and the phone's Devices half was permanently empty, while
    // `loading` stayed true forever underneath it. Same defect `useJobsAuth`
    // documents for Jobs and `useImportApi` carried for the import half.
    if (!authenticated) {
      return;
    }

    let cancelled = false;

    void fetchJson<RegisteredDevice[]>('/api/devices', {
      // Only when there IS one. An empty bearer is a malformed header on a
      // request that would otherwise authenticate with the key.
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    })
      .then((rows) => {
        if (!cancelled) {
          setDevices([...(rows ?? [])].sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1)));
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDevices([]);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authToken, authenticated]);

  return { devices, loading };
}
