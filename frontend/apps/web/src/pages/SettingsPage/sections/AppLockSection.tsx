import { useState } from 'react';

import {
  APP_LOCK_GRACES,
  APP_LOCK_GRACE_LABELS,
  type AppLockGrace,
  describeBiometry,
  isAndroidPlatform,
  isNativePlatform,
} from '@ci/common';
import { Button, Card, Label, Select, Switch } from '@ci/shadcn';
import { LockKeyhole } from '@ci/shadcn/icons';

import { useAppLock } from '@/hooks/useAppLock';

/**
 * Settings → App lock: require your face, fingerprint or device passcode to open the
 * app. The settings live natively (so a cold start locks before the page loads); this
 * section reads and writes them through the plugin. Turning the lock on runs the prompt
 * once first — nobody enables a lock they cannot pass.
 */
export function AppLockSection() {
  const [status, { configure, lock }] = useAppLock();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (!isNativePlatform() || status === null) {
    return (
      <Card>
        <Card.Header>
          <Card.Title>App lock</Card.Title>
          <Card.Description>
            {isNativePlatform()
              ? 'Checking this device…'
              : 'The app lock is available in the iOS and Android apps, where your face, fingerprint or passcode can guard the app.'}
          </Card.Description>
        </Card.Header>
      </Card>
    );
  }

  const run = async (change: () => Promise<unknown>) => {
    setBusy(true);
    setNotice(null);

    try {
      await change();
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = (enabled: boolean) =>
    run(async () => {
      const next = await configure({ enabled });

      if (enabled && next && !next.enabled) {
        setNotice(
          next.reason === 'authentication-cancelled'
            ? 'The lock stays off: the unlock check was cancelled. Try again when you are ready.'
            : (next.reason ?? 'The lock could not be turned on.'),
        );
      }
    });

  return (
    <Card>
      <Card.Header>
        <Card.Title className="flex items-center gap-2">
          <LockKeyhole className="h-5 w-5" aria-hidden />
          App lock
        </Card.Title>
        <Card.Description>
          Ask for your face, fingerprint or device passcode before showing your memory. Captures and sync keep
          running behind the lock; only the screen is covered.
        </Card.Description>
      </Card.Header>
      <Card.Content className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="app-lock-enabled">Require unlock</Label>
            <p className="text-sm text-muted-foreground">{describeBiometry(status.biometry)}</p>
            {!status.available && status.reason ? (
              <p className="text-sm text-destructive">{status.reason}</p>
            ) : null}
          </div>
          <Switch
            id="app-lock-enabled"
            checked={status.enabled}
            disabled={busy || (!status.enabled && !status.available)}
            onCheckedChange={(checked) => void toggleEnabled(checked)}
          />
        </div>

        {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}

        <div className="space-y-2">
          <Label htmlFor="app-lock-grace">Lock again</Label>
          <Select
            value={status.grace}
            disabled={busy || !status.enabled}
            onValueChange={(value) => void run(() => configure({ grace: value as AppLockGrace }))}
          >
            <Select.Trigger id="app-lock-grace" className="w-full">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {APP_LOCK_GRACES.map((grace) => (
                <Select.Item key={grace} value={grace}>
                  {APP_LOCK_GRACE_LABELS[grace].label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
          <p className="text-sm text-muted-foreground">{APP_LOCK_GRACE_LABELS[status.grace].hint}</p>
        </div>

        {/* Android only: FLAG_SECURE is a real choice there. iOS always blurs the app in
            the switcher while the lock is on and has no screenshot block, so a switch
            would do nothing and is not shown. */}
        {isAndroidPlatform() && (
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="app-lock-secure">Hide in app switcher and prevent screenshots</Label>
              <p className="text-sm text-muted-foreground">
                Shows a blank card in recent apps and blocks screenshots and screen recording, including your
                own.
              </p>
            </div>
            <Switch
              id="app-lock-secure"
              checked={status.secureScreen}
              disabled={busy || !status.enabled}
              onCheckedChange={(checked) => void run(() => configure({ secureScreen: checked }))}
            />
          </div>
        )}

        <Button variant="outline" disabled={busy || !status.enabled} onClick={() => void run(lock)}>
          Lock now
        </Button>
      </Card.Content>
    </Card>
  );
}
