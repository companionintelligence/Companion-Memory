import { useState } from 'react';

import { refreshDeviceAccessToken, type DeviceAppOutdated as Outdated } from '@ci/common';
import { Button, Card } from '@ci/shadcn';

export const DEVICE_APP_OUTDATED_COPY: Record<Outdated, { title: string; body: string }> = {
  memory: {
    title: 'Memory needs an update',
    body:
      'This app signs in to Memory with short-lived passes, and the Memory it is connected to is too old to ' +
      'give them out. Update Memory (on a Hub, update the Companion Memory app), then check again. You are ' +
      'still signed in, and anything waiting to upload is kept.',
  },
  app: {
    title: 'Update this app',
    body:
      'This version of the app is older than the Memory it is connected to and cannot sign in to it safely. ' +
      'Update the app to keep using it. You are still signed in, and anything waiting to upload is kept.',
  },
};

/**
 * Shown in place of every signed-in page while the native side answers `legacy`
 * (`deviceAppOutdated` in @ci/common): Memory, or this app's own shell, is too old to trade the
 * device key for short-lived tokens.
 *
 * The page used to be handed the key itself then, a credential that works from anywhere until it
 * is revoked, in reach of any script that ran in the page. Now it has nothing to send, so rather
 * than let every page fail on its own terms (or send a signed-in person to sign in again, which
 * would mint a key the same Memory cannot trade either), it says what to update. Nothing is signed
 * out and the queue is untouched.
 */
export function DeviceAppOutdated({ outdated }: { outdated: Outdated }) {
  const [checking, setChecking] = useState(false);
  const copy = DEVICE_APP_OUTDATED_COPY[outdated];

  const checkAgain = () => {
    setChecking(true);
    void refreshDeviceAccessToken(null).finally(() => setChecking(false));
  };

  return (
    <div
      className="flex h-lvh w-full items-center justify-center p-6 md:p-10"
      data-testid="device-app-outdated"
    >
      <Card className="w-full max-w-md rounded-2xl border">
        <Card.Header>
          <Card.Title className="text-center">{copy.title}</Card.Title>
        </Card.Header>
        <Card.Content className="space-y-4 text-center">
          <p className="text-muted-foreground">{copy.body}</p>
          {outdated === 'memory' && (
            <div className="flex flex-col items-center gap-2">
              <Button variant="outline" onClick={checkAgain} disabled={checking}>
                {checking ? 'Checking…' : 'Check again'}
              </Button>
            </div>
          )}
        </Card.Content>
      </Card>
    </div>
  );
}
