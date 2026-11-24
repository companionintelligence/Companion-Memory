import { isIosPlatform } from '@ci/common';
import {
  AppWindow,
  Bookmark,
  History,
  Monitor,
  MonitorSmartphone,
  MousePointerClick,
  Search,
} from '@ci/shadcn/icons';
import { useNavigate } from 'react-router-dom';

import { SourceCard, type TrackedObject } from '@/components/connect/SourceCard';
import {
  CAPTURE_DOWNLOAD_URL,
  CHROME_EXTENSION_URL,
  FIREFOX_EXTENSION_URL,
} from '@/pages/OnboardingPage/constants';

import { PathHeader } from './PathHeader';
import { useDevices, type RegisteredDevice } from './useDevices';

/** Every browser extension hands over the same three things. */
export const BROWSER_TRACKS: readonly TrackedObject[] = [
  { icon: History, label: 'Browsing history' },
  { icon: Bookmark, label: 'Bookmarks' },
  { icon: Search, label: 'Searches' },
];

/** As does Capture, on whichever desktop it runs. */
export const CAPTURE_TRACKS: readonly TrackedObject[] = [
  { icon: Monitor, label: 'Screen context' },
  { icon: AppWindow, label: 'App usage' },
  { icon: MousePointerClick, label: 'Desktop activity' },
];

/**
 * The devices path: everything you install rather than sign into.
 *
 * Three to a row, full width. Every gallery here holds exactly three entries —
 * three browsers, three desktop platforms — so a fourth column was a permanent
 * empty cell, and capping the width left the three that were there huddled
 * against the left of the page.
 *
 * Browsers and desktops share one path because the appliance already treats
 * them as one thing — both register in the device table, `device_type:
 * 'browser'` alongside `laptop` and `desktop`, and both answer the same
 * question: which of my machines is feeding this, and is it still doing it.
 *
 * What has reported in leads, exactly as connected accounts lead the services
 * path, so the shape of every path on this page is the same: what you already
 * have, then what you could add.
 */
export function DevicesPanel() {
  const { devices, loading } = useDevices();
  const navigate = useNavigate();

  return (
    <div className="w-full">
      <PathHeader path="devices" />

      {!loading && devices.length > 0 && (
        <section className="mb-8 w-full">
          <h2 className="mb-1 text-2xl font-bold">Your devices</h2>
          <p className="text-muted-foreground mb-6">Everything that has reported in, most recent first.</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:gap-4 lg:grid-cols-3">
            {devices.map((device) => (
              <DeviceCard key={device.device_id} device={device} />
            ))}
          </div>
        </section>
      )}

      <section className="mb-8 w-full">
        <h3 className="mb-3 text-lg font-semibold">Browser extensions</h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:gap-4 lg:grid-cols-3">
          <SourceCard
            logo="/branding/chrome/logo.svg"
            name="Chrome"
            tracks={BROWSER_TRACKS}
            onSelect={() => window.open(CHROME_EXTENSION_URL, '_blank', 'noopener,noreferrer')}
          />
          <SourceCard
            logo="/branding/firefox/logo.svg"
            name="Firefox"
            tracks={BROWSER_TRACKS}
            onSelect={() => window.open(FIREFOX_EXTENSION_URL, '_blank', 'noopener,noreferrer')}
          />
          {/* The Safari extension ships INSIDE the iOS app (and only there), and
              Settings → Safari has the steps that switch it on. Elsewhere there
              is nothing to install yet, so the card stays an honest "coming
              soon" — on the one phone that already has it, it must not say so. */}
          {isIosPlatform() ? (
            <SourceCard
              logo="/branding/safari/logo.svg"
              name="Safari"
              tracks={BROWSER_TRACKS}
              onSelect={() => navigate('/settings/safari')}
            />
          ) : (
            <SourceCard logo="/branding/safari/logo.svg" name="Safari" tracks={BROWSER_TRACKS} comingSoon />
          )}
        </div>
      </section>

      <section className="w-full">
        <h3 className="mb-3 text-lg font-semibold">Companion Capture</h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:gap-4 lg:grid-cols-3">
          <SourceCard
            logo="/branding/mac/logo.svg"
            name="macOS"
            tracks={CAPTURE_TRACKS}
            onSelect={() => window.open(CAPTURE_DOWNLOAD_URL, '_blank', 'noopener,noreferrer')}
          />
          <SourceCard
            logo="/branding/windows/logo.svg"
            name="Windows"
            tracks={CAPTURE_TRACKS}
            onSelect={() => window.open(CAPTURE_DOWNLOAD_URL, '_blank', 'noopener,noreferrer')}
          />
          <SourceCard
            logo="/branding/linux/logo.svg"
            name="Linux"
            tracks={CAPTURE_TRACKS}
            onSelect={() => window.open(CAPTURE_DOWNLOAD_URL, '_blank', 'noopener,noreferrer')}
          />
        </div>
      </section>
    </div>
  );
}

/** A brand mark for a registered device, chosen from what it told us it is. */
function deviceLogo(device: RegisteredDevice): string | undefined {
  const platform = device.platform?.toLowerCase();

  if (device.device_type === 'browser') {
    const name = device.device_name.toLowerCase();

    if (name.includes('firefox')) {
      return '/branding/firefox/logo.svg';
    }

    if (name.includes('safari')) {
      return '/branding/safari/logo.svg';
    }

    return '/branding/chrome/logo.svg';
  }

  if (platform === 'macos' || platform === 'ios') {
    return '/branding/mac/logo.svg';
  }

  if (platform === 'windows') {
    return '/branding/windows/logo.svg';
  }

  if (platform === 'linux') {
    return '/branding/linux/logo.svg';
  }

  if (platform === 'android') {
    return '/branding/android/logo.svg';
  }

  return undefined;
}

function DeviceCard({ device }: { device: RegisteredDevice }) {
  const tracks: TrackedObject[] =
    device.device_type === 'browser' ? [...BROWSER_TRACKS] : [...CAPTURE_TRACKS];
  const logo = deviceLogo(device);

  return (
    <SourceCard
      logo={logo}
      icon={logo ? undefined : <MonitorSmartphone aria-hidden className="h-full w-full" strokeWidth={1.5} />}
      name={device.device_name}
      tracks={tracks}
      // A registered device is in use by definition — it registered by
      // reporting — so `count` is what turns the card green and says so.
      count={device.is_active ? 1 : 0}
      lastActivityAt={device.last_seen}
      activityVerb="synced"
    />
  );
}
