import { Button } from '@ci/shadcn';

import { usePWAInstall } from '@/hooks';

export function PWAInstall() {
  const { isInstallable, promptInstall } = usePWAInstall();

  if (!isInstallable) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <Button onClick={promptInstall} className="touch-target shadow-lg" size="sm">
        📱 Install App
      </Button>
    </div>
  );
}
