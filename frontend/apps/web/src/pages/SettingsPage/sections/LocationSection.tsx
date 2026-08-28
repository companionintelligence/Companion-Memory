import { useCallback, useEffect, useState } from 'react';

import {
  fetchJson,
  isNativePlatform,
  openNativeLocationSettings,
  type LocationTrackingMode,
} from '@ci/common';
import { AlertDialog, Button, Card, cn } from '@ci/shadcn';
import { MapPin } from '@ci/shadcn/icons';

import { useAuth, useLocationTracking } from '@/hooks';

interface PositionStats {
  total: number;
  byProvider: Record<string, number>;
  lastFixAt: string | null;
}

/** Providers written by the device-native location source — see @ci/common deviceSources. */
const DEVICE_PROVIDERS = ['browser', 'companion-mobile'];

const MODES: Array<{
  value: LocationTrackingMode;
  label: string;
  nativeOnly?: boolean;
}> = [
  { value: 'off', label: 'Off' },
  { value: 'when_in_use', label: 'While using' },
  { value: 'always', label: 'Always', nativeOnly: true },
];

/**
 * Settings -> Location: device location tracking.
 *
 * The confirm dialogs are the **prominent disclosure** Play requires for a
 * sensitive permission (DEVICE_DATA_COMPLIANCE.md §8). Consent is an affirmative
 * tap on **"Agree"** — Play names "Allow access" and "Got it" as insufficient.
 * Declining leaves the app fully usable.
 */
export function LocationSection() {
  const [{ authToken, authenticated }] = useAuth();
  const { mode, setMode, needsSettingsUpgrade } = useLocationTracking({ watch: false });
  const [stats, setStats] = useState<PositionStats | null>(null);
  const [pendingMode, setPendingMode] = useState<Exclude<LocationTrackingMode, 'off'> | null>(null);
  const showAlways = isNativePlatform();

  const refreshStats = useCallback(async () => {
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
  }, [refreshStats, mode]);

  const trackedCount = DEVICE_PROVIDERS.reduce(
    (total, provider) => total + (stats?.byProvider?.[provider] ?? 0),
    0,
  );

  const visibleModes = MODES.filter((entry) => !entry.nativeOnly || showAlways);

  const onSelectMode = (next: LocationTrackingMode) => {
    if (next === mode) {
      return;
    }

    if (next === 'off') {
      setMode('off');

      return;
    }

    if (privilegeRank(next) <= privilegeRank(mode)) {
      setMode(next);

      return;
    }

    setPendingMode(next);
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <MapPin className="h-5 w-5" />
          Location
        </h2>
        <p className="text-sm text-muted-foreground">
          Track where you are so your memory can place events, photos and messages on a map.
        </p>
      </div>

      <Card>
        <Card.Header>
          <Card.Title className="text-base">Location on this device</Card.Title>
          <Card.Description>{modeDescription(mode, showAlways)}</Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col gap-4">
          <div
            role="radiogroup"
            aria-label="Location tracking"
            className="flex gap-1 rounded-md bg-muted p-1 text-xs"
          >
            {visibleModes.map((entry) => (
              <button
                key={entry.value}
                type="button"
                role="radio"
                aria-checked={mode === entry.value}
                onClick={() => onSelectMode(entry.value)}
                className={cn(
                  'flex-1 cursor-pointer rounded-sm px-2 py-1.5 transition-colors',
                  mode === entry.value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>

          {!showAlways && (
            <p className="text-sm text-muted-foreground">
              Background location is on the mobile app. This device records places only while Companion is
              open.
            </p>
          )}

          {needsSettingsUpgrade && showAlways && (
            <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
              <p>
                Your device didn&apos;t grant background location access. Open Settings to allow it if you
                want Companion to remember places after you leave the app.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void openNativeLocationSettings()}
              >
                Open Settings
              </Button>
            </div>
          )}

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

      <AlertDialog
        open={pendingMode === 'when_in_use'}
        onOpenChange={(open) => !open && setPendingMode(null)}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>Record your location while using Companion?</AlertDialog.Title>
            <AlertDialog.Description>
              <span className="block">
                Companion collects this device&apos;s location — including precise GPS location — while the
                app is open, so it can place your notes, photos and events on a map and work out where you
                were when something happened.
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
            <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
            <AlertDialog.Action
              onClick={() => {
                setMode('when_in_use');
                setPendingMode(null);
              }}
            >
              Agree
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog>

      <AlertDialog open={pendingMode === 'always'} onOpenChange={(open) => !open && setPendingMode(null)}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>Remember places in the background?</AlertDialog.Title>
            <AlertDialog.Description>
              <span className="block">
                Companion records your location in the background, including while your phone is locked or the
                app is closed, so it can attach places to your memories after you leave the app. Your device
                will show an ongoing indicator while this is on — a persistent notification on Android, the
                blue location indicator on iOS.
              </span>
              <span className="mt-2 block">
                This cannot work with While Using only. Locations are sent only to your own Companion server,
                are never used for advertising, and you can turn this off here at any time.
              </span>
              <span className="mt-2 block">
                Your device will ask for background/Always Allow next. You can stay on While Using and keep
                using Companion.
              </span>
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
            <AlertDialog.Action
              onClick={() => {
                setMode('always');
                setPendingMode(null);
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

function privilegeRank(mode: LocationTrackingMode): number {
  if (mode === 'off') {
    return 0;
  }

  if (mode === 'when_in_use') {
    return 1;
  }

  return 2;
}

function modeDescription(mode: LocationTrackingMode, native: boolean): string {
  if (mode === 'off') {
    return 'This device is not recording location.';
  }

  if (mode === 'always' && native) {
    return 'Companion records your location in the background, including while your phone is locked or the app is closed, so it can attach places to your notes, photos and events on the map.';
  }

  return 'While Companion is open, this device records your location when you move about 50 metres or every five minutes. Fixes are stored privately in your position history.';
}
