import { useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

interface BlueBubblesConfigResponse {
  enabled: boolean;
  lastSyncCursor: string | null;
  lastWebhookReceivedAt: string | null;
}

export interface BlueBubblesStatus {
  /** The appliance has this connection turned on — the same bar an OAuth card's "Connected" badge uses (an active row), not a live reachability check. */
  enabled: boolean;
  /** Whichever of sync or webhook activity is more recent, for the card's "synced …" line. */
  lastActivityAt: string | null;
}

const EMPTY_STATUS: BlueBubblesStatus = { enabled: false, lastActivityAt: null };

/**
 * BlueBubbles isn't part of the `providers`/`connections` OAuth catalog this
 * grid otherwise reads from — it's a single appliance-wide connection with
 * its own REST config (see BlueBubblesConfigController /
 * SettingsPage/sections/BlueBubblesSection), so its card needs its own fetch
 * rather than a slot in `SERVICE_PROVIDERS`.
 *
 * Mirrors `useDevices`: best-effort (an unreachable config just leaves the
 * card looking unconnected) and gated on `authenticated` rather than
 * `authToken` — the latter is the web JWT and is null in the native app,
 * whose durable credential is a keystore API key `fetchJson` attaches as
 * `x-api-key` on its own.
 */
export function useBlueBubblesStatus(): BlueBubblesStatus {
  const [{ authToken, authenticated }] = useAuth();
  const [status, setStatus] = useState<BlueBubblesStatus>(EMPTY_STATUS);

  useEffect(() => {
    if (!authenticated) {
      return;
    }

    let cancelled = false;

    fetchJson<BlueBubblesConfigResponse>('/api/bluebubbles/config', {
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    })
      .then((data) => {
        if (cancelled || !data) {
          return;
        }

        const lastActivityAt =
          [data.lastSyncCursor, data.lastWebhookReceivedAt]
            .filter((value): value is string => Boolean(value))
            .sort()
            .at(-1) ?? null;

        setStatus({ enabled: data.enabled, lastActivityAt });
      })
      .catch(() => {
        if (!cancelled) {
          setStatus(EMPTY_STATUS);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authToken, authenticated]);

  return status;
}
