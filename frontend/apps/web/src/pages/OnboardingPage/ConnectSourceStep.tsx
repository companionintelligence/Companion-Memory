import { useState } from 'react';

import { AppWindow, History, Smartphone } from '@ci/shadcn/icons';

import { ConnectedAccountsSection } from '@/components/connect/ConnectedAccountsSection';
import { ProviderConnectDialog } from '@/components/connect/ProviderConnectDialog';
import { ServiceIntegrationsSection } from '@/components/connect/ServiceIntegrationsSection';
import { SourceCard } from '@/components/connect/SourceCard';
import { BROWSER_TRACKS, CAPTURE_TRACKS } from '@/pages/SourcesPage/DevicesPanel';

import { CAPTURE_DOWNLOAD_URL, CHROME_EXTENSION_URL, FIREFOX_EXTENSION_URL } from './constants';
import { StepHeader } from './StepHeader';

// The lists are imported from the panels that own them, so setup and
// /sources cannot drift apart.

export function ConnectSourceStep() {
  const [dialogProviderId, setDialogProviderId] = useState<string | null>(null);

  const openCaptureDownload = () => window.open(CAPTURE_DOWNLOAD_URL, '_blank', 'noopener,noreferrer');

  return (
    <div className="space-y-6 w-full mx-auto">
      <StepHeader title="Connect a source" description="Pull your email and calendar in automatically." />

      <div className="space-y-4 max-w-5xl mx-auto w-full">
        <p className="text-lg sm:text-xl leading-snug text-muted-foreground text-center px-2">
          On the computer you use most, download Companion Capture. It streams screenshots and activity logs
          into your memory.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4">
          <SourceCard
            logo="/branding/mac/logo.svg"
            name="macOS"
            tracks={CAPTURE_TRACKS}
            onSelect={openCaptureDownload}
          />
          <SourceCard
            logo="/branding/windows/logo.svg"
            name="Windows"
            tracks={CAPTURE_TRACKS}
            onSelect={openCaptureDownload}
          />
          <SourceCard
            logo="/branding/linux/logo.svg"
            name="Linux"
            tracks={CAPTURE_TRACKS}
            onSelect={openCaptureDownload}
          />
        </div>
      </div>

      <div className="space-y-4 max-w-5xl mx-auto w-full">
        <p className="text-lg sm:text-xl leading-snug text-muted-foreground text-center px-2">
          Want your memory to include desktop or mobile browser history? Get the browser extension.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4">
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
          <SourceCard
            logo="/branding/ios/logo.svg"
            name="iPhone & iPad"
            tracks={[
              { icon: Smartphone, label: 'Mobile browsing' },
              { icon: AppWindow, label: 'App usage' },
              { icon: History, label: 'Screen time' },
            ]}
            // The iOS app is a closed preview, so there is nothing public to
            // download: an inert "coming soon" card, not a link to a page that
            // has no iPhone build on it.
            comingSoon
          />
        </div>
      </div>

      <div className="space-y-4 max-w-5xl mx-auto w-full">
        <p className="text-lg sm:text-xl leading-snug text-muted-foreground text-center px-2">
          Connect an account you already use. Email, calendar, photos, and social history come in
          automatically.
        </p>
        <ConnectedAccountsSection />
        <ServiceIntegrationsSection
          variant="onboarding"
          onProviderSelect={(rawId) => setDialogProviderId(rawId)}
        />
      </div>

      <ProviderConnectDialog
        rawProviderId={dialogProviderId}
        open={dialogProviderId != null}
        resumeOnboarding
        onOpenChange={(open) => {
          if (!open) {
            setDialogProviderId(null);
          }
        }}
        onConnected={() => {
          setDialogProviderId(null);
        }}
      />
    </div>
  );
}
