import { useDeviceLayout } from '@ci/common';
import { Toaster } from '@ci/shadcn';

import { useTheme } from '@/components/ThemePicker';

// On a phone sonner's default sits 16px from the top or bottom edge, under the
// status bar / Dynamic Island or over the home indicator, and on a full-width
// toast across whatever control lives there. Top-center past the safe area and
// the phone header puts it in the content well instead.
const PHONE_OFFSET = { top: 'calc(var(--safe-area-top) + 3.5rem)' };

/**
 * The app's toaster, themed and placed for the device. Every screen that can
 * raise a toast renders this once: MainLayout for the pages inside it, and any
 * page routed outside it (ProviderPage) for itself. Where it sits in the tree is
 * the caller's call; MainLayout's comments say why its two spots matter.
 */
export function AppToaster() {
  const { isMobile } = useDeviceLayout();
  const { themeState } = useTheme();

  if (isMobile) {
    return (
      <Toaster
        position="top-center"
        offset={PHONE_OFFSET}
        mobileOffset={PHONE_OFFSET}
        theme={themeState.mode}
      />
    );
  }

  return <Toaster theme={themeState.mode} />;
}
