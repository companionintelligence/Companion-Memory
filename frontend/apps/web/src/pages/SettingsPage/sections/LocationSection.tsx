import { useCallback, useEffect, useState } from 'react';

import {
  fetchJson,
  isAndroidPlatform,
  isIosPlatform,
  isNativePlatform,
  openNativeLocationSettings,
  type LocationTrackingMode,
} from '@ci/common';
import { AlertDialog, Button, Card, cn } from '@ci/shadcn';
import { MapPin } from '@ci/shadcn/icons';

import { useAuth, useLocationTracking } from '@/hooks';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';

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

type NativePlatform = 'ios' | 'android';

/**
 * The OS-specific sentences of the background-location disclosure. The Always option only
 * exists in the native shells, so the dialog never renders on web and the record needs no
 * `web` entry. Play reviews the Android text as the background-location disclosure: it has
 * to name location data and the feature it serves, say collection goes on when the app is
 * closed or not in use (the shared first sentence does that), and must not suggest a grant
 * the app does not ask for -- there is no "Physical activity" permission behind this.
 */
const ALWAYS_COPY: Record<NativePlatform, { indicator: string; prompt: string }> = {
  ios: {
    indicator: 'On iPhone that stays quiet while you are still, with no solid blue location indicator.',
    prompt:
      'iOS asks twice: Allow While Using the App, then Always Allow. If the second prompt does not appear, use Open Settings and set Location to Always.',
  },
  android: {
    indicator:
      'On Android, location is recorded only while you are on the move. A notification shows while that is happening, which the system requires, and nothing runs while you are still.',
    prompt:
      'Android asks for notification and location access first, then opens a settings page where you choose Allow all the time. If that page does not appear, use Open Settings and set Location permission to Allow all the time.',
  },
};

function nativePlatform(): NativePlatform | null {
  if (isIosPlatform()) {
    return 'ios';
  }

  if (isAndroidPlatform()) {
    return 'android';
  }

  return null;
}

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
  const fmt = useDateTimeFormat();
  const { mode, setMode, needsSettingsUpgrade } = useLocationTracking({ watch: false });
  const [stats, setStats] = useState<PositionStats | null>(null);
  const [pendingMode, setPendingMode] = useState<Exclude<LocationTrackingMode, 'off'> | null>(null);
  const showAlways = isNativePlatform();
  // Resolved once: the shell never changes during a session.
  const platform = nativePlatform();
  const alwaysCopy = platform ? ALWAYS_COPY[platform] : null;

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
              Background location is on the mobile app. This device uses location only when you ask it to,
              such as placing a note or photo.
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
            {stats?.lastFixAt && <div>Last fix {fmt.dateTime(stats.lastFixAt)}</div>}
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
          <AlertDialog.Header className="text-left">
            <AlertDialog.Title>Use your location while using Companion?</AlertDialog.Title>
            <AlertDialog.Description>
              <span className="block">
                Companion can use this phone&apos;s location when you ask it to, such as placing a note or
                photo on the map. Nothing is recorded in the background.
              </span>
              <span className="mt-2 block">
                Locations go only to your Companion server — never ads. You can say no and keep using the app.
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
          <AlertDialog.Header className="text-left">
            <AlertDialog.Title>Remember places in the background?</AlertDialog.Title>
            <AlertDialog.Description>
              <span className="block">
                Companion collects location data to place your notes, photos and events on your map, even when
                the app is closed or not in use.
                {alwaysCopy && ` ${alwaysCopy.indicator}`}
              </span>
              {alwaysCopy && <span className="mt-2 block">{alwaysCopy.prompt}</span>}
              <span className="mt-2 block">
                Locations go only to your Companion server and are never used for ads. You can stay on While
                using, or turn location off, and keep using Companion.
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

  return "Companion uses this device's location only when you ask it to, such as placing a note or photo. Nothing is recorded in the background.";
}
