import { useState } from 'react';

import { ExternalLink } from '@ci/shadcn/icons';

import { BrandPrimaryButton } from '@/components/BrandPrimaryButton/BrandPrimaryButton';
import { ProviderConnectDialog } from '@/components/connect/ProviderConnectDialog';
import { ServiceIntegrationsSection } from '@/components/connect/ServiceIntegrationsSection';
import { Card } from '@/pages/ConnectPage/Card';

import { CAPTURE_DOWNLOAD_URL, CHROME_EXTENSION_URL, CI_DOWNLOAD_URL, IMPORT_TOOLS_URL } from './constants';
import { StepHeader } from './StepHeader';

export function ConnectSourceStep() {
  const [dialogProviderId, setDialogProviderId] = useState<string | null>(null);

  const openDownload = () => window.open(CI_DOWNLOAD_URL, '_blank', 'noopener,noreferrer');
  const openCaptureDownload = () => window.open(CAPTURE_DOWNLOAD_URL, '_blank', 'noopener,noreferrer');

  return (
    <div className="space-y-6 w-full mx-auto">
      <StepHeader title="Connect a source" description="Pull your email and calendar in automatically." />

      <ServiceIntegrationsSection
        variant="onboarding"
        disabledWhenConnected
        onProviderSelect={(rawId) => setDialogProviderId(rawId)}
      />

      <div className="space-y-4 max-w-5xl mx-auto w-full">
        <p className="text-lg sm:text-xl leading-snug text-muted-foreground text-center px-2">
          Want your memory to include desktop or mobile browser history? Get the browser extension.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4">
          <Card
            logo="/branding/chrome/logo.svg"
            background="bg-blue-500"
            border="border-blue-400"
            text="Install the Chrome extension to automatically track your browsing history, bookmarks, and web activity."
            onClick={() => window.open(CHROME_EXTENSION_URL, '_blank', 'noopener,noreferrer')}
          />
          <Card
            logo="/branding/firefox/logo.svg"
            background="bg-orange-500"
            border="border-orange-400"
            text="Get the Firefox extension to capture your web browsing patterns and site interactions."
            disabled
          />
          <Card
            logo="/branding/ios/logo.svg"
            background="bg-blue-500"
            border="border-blue-400"
            text="Download the iOS app to track your mobile usage, screen time, and app interactions on iPhone and iPad."
            onClick={openDownload}
          />
        </div>
      </div>

      <div className="space-y-4 max-w-5xl mx-auto w-full">
        <p className="text-lg sm:text-xl leading-snug text-muted-foreground text-center px-2">
          On the computer you use most, download Companion Capture. It streams screenshots and activity logs
          into your memory.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4">
          <Card
            logo="/branding/mac/logo.svg"
            background="bg-gray-600"
            border="border-gray-500"
            text="Download Companion Capture for macOS (Apple Silicon and Intel)."
            onClick={openCaptureDownload}
          />
          <Card
            logo="/branding/windows/logo.svg"
            background="bg-blue-600"
            border="border-blue-500"
            text="Download Companion Capture for Windows."
            onClick={openCaptureDownload}
          />
          <Card
            logo="/branding/linux/logo.svg"
            background="bg-yellow-600"
            border="border-yellow-500"
            text="Download Companion Capture for Linux (deb and AppImage)."
            onClick={openCaptureDownload}
          />
        </div>
      </div>

      <div className="rounded-xl border border-border/70 bg-background/70 p-5 space-y-3 max-w-2xl mx-auto w-full">
        <p className="text-lg sm:text-xl leading-snug text-muted-foreground">
          Have local exports? Import tools can seed your memory faster.
        </p>
        <BrandPrimaryButton className="w-full sm:w-auto text-base sm:text-lg h-12 px-6" asChild>
          <a href={IMPORT_TOOLS_URL} target="_blank" rel="noopener noreferrer">
            Get import tools
            <ExternalLink className="ml-2 h-4 w-4" />
          </a>
        </BrandPrimaryButton>
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
