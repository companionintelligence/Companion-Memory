import { useCallback, useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';
import { AlertDialog, Button, Card, Switch } from '@ci/shadcn';
import { MapPin } from '@ci/shadcn/icons';

import { useAuth, useLocationTracking } from '@/hooks';

interface PositionStats {
  total: number;
  byProvider: Record<string, number>;
  lastFixAt: string | null;
}

/** Providers written by the device-native location source — see @ci/common deviceSources. */
const DEVICE_PROVIDERS = ['browser', 'companion-mobile'];

/**
 * Settings -> Location: device location tracking (issue #1811). Enable/disable
 * recording of ci.position fixes from this device, with live counts — the
 * LifeScope locations settings rebuilt on the position store.
 *
 * The confirm dialog is also the **prominent disclosure** Play requires for a
 * sensitive permission (DEVICE_DATA_COMPLIANCE.md §8), which is a rejection cause
 * in its own right regardless of whether the permission is granted. Three details
 * there are load-bearing and should not be "tidied": it must appear in-app
 * immediately before the OS prompt (not in the listing or the privacy policy), it
 * must answer why/what/how in plain language, and consent must be an affirmative
 * tap on a button reading **"Agree"** — Play names "Allow access" and "Got it" as
 * explicitly insufficient. Declining leaves the app fully usable.
 */
export function LocationSection() {
  const [{ authToken, authenticated }] = useAuth();
  // State-only: the app-level instance in AppRoutes owns the geolocation
  // watcher. Registering a second watcher here would double-post every fix
  // while this page is open.
  const { enabled, setEnabled } = useLocationTracking({ watch: false });
  const [stats, setStats] = useState<PositionStats | null>(null);
  const [confirming, setConfirming] = useState(false);

  const refreshStats = useCallback(async () => {
    // Native authenticates by API key with no JWT — gate on `authenticated`.
    if (!authenticated) {
      return;
    }

    try {
      const data = await fetchJson<PositionStats>('/api/position/stats', {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
      });
      if (data) {
        setStats(data);
      }
    } catch {
      // Stats are informational; leave the section usable without them.
    }
  }, [authToken, authenticated]);

  useEffect(() => {
    void refreshStats();
  }, [refreshStats, enabled]);

  const trackedCount = DEVICE_PROVIDERS.reduce(
    (total, provider) => total + (stats?.byProvider?.[provider] ?? 0),
    0,
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <MapPin className="h-5 w-5" />
          Location
        </h2>
        <p className="text-sm text-muted-foreground">
          Track where you are so your memory can place events, photos and messages on the map.
        </p>
      </div>

      <Card>
        <Card.Header>
          <Card.Title className="text-base">Location tracking on this device</Card.Title>
          <Card.Description>
            While enabled, this device records your location as you use Companion — throttled to meaningful
            movement (about 50 metres) or every five minutes, whichever comes first. Fixes are stored
            privately in your position history and improve location estimates for everything else in your
            memory. On phones, a fix taken with no connection is saved on the device and sent when your server
            is reachable again.
          </Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">
              {enabled ? 'Tracking is on for this device' : 'Tracking is off'}
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={(next) => {
                if (next) {
                  setConfirming(true);
                } else {
                  setEnabled(false);
                }
              }}
              aria-label="Toggle location tracking on this device"
            />
          </div>

          <div className="text-sm text-muted-foreground">
            <div>{trackedCount} fixes recorded from your devices</div>
            <div>{stats ? `${stats.total} position fixes total` : 'Loading position stats…'}</div>
            {stats?.lastFixAt && <div>Last fix {new Date(stats.lastFixAt).toLocaleString()}</div>}
          </div>

          <div>
            <Button variant="outline" size="sm" onClick={() => void refreshStats()}>
              Refresh stats
            </Button>
          </div>
        </Card.Content>
      </Card>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>Record your location?</AlertDialog.Title>
            <AlertDialog.Description>
              <span className="block">
                Companion collects this device&apos;s location — including precise GPS location — while the
                app is open, so it can place your notes, photos and events on a map and work out where you
                were when something happened. It does not track you in the background.
              </span>
              <span className="mt-2 block">
                Locations are sent only to your own Companion server. They are not shared with anyone else and
                are never used for advertising. They stay in your private position history until you delete
                them, and turning this off stops new recordings.
              </span>
              <span className="mt-2 block">
                Your device will ask for permission next. You can say no and keep using Companion — only this
                feature turns off.
              </span>
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            {/* "Cancel" / "Agree" is the exact affirmative-consent pairing Play asks for. */}
            <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
            <AlertDialog.Action
              onClick={() => {
                setEnabled(true);
                setConfirming(false);
              }}
            >
              Agree
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog>
    </div>
  );
}
