import { useState } from 'react';

import {
  APP_LOCK_GRACES,
  APP_LOCK_GRACE_LABELS,
  type AppLockGrace,
  describeBiometry,
  isAndroidPlatform,
  isNativePlatform,
} from '@ci/common';
import { Button, Select, Switch } from '@ci/shadcn';

import { useAppLock } from '@/hooks/useAppLock';

import { SettingsFooter, SettingsGroup, SettingsRow, SettingsSection, SettingsStatus } from '../kit';

/**
 * Settings → App lock: require your face, fingerprint or device passcode to open the
 * app. The settings live natively (so a cold start locks before the page loads); this
 * section reads and writes them through the plugin. Turning the lock on runs the prompt
 * once first — nobody enables a lock they cannot pass — and so does loosening it (off, a
 * longer grace, no screen protection), so a page script cannot quietly turn it off.
 */
export function AppLockSection() {
  const [status, { configure, lock }] = useAppLock();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (!isNativePlatform() || status === null) {
    return (
      <SettingsSection
        title="App lock"
        description={
          isNativePlatform()
            ? 'Checking this device…'
            : 'The app lock is available in the iOS and Android apps, where your face, fingerprint or passcode can guard the app.'
        }
      />
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
      } else if (!enabled && next?.enabled) {
        // Turning it off asks for the same check as unlocking.
        setNotice('The lock stays on: the unlock check was cancelled. Try again when you are ready.');
      }
    });

  /** A longer grace or no screen protection asks for the unlock check too; cancelled, nothing changes. */
  const change = (settings: { grace?: AppLockGrace; secureScreen?: boolean }) =>
    run(async () => {
      const next = await configure(settings);

      if (next?.reason === 'authentication-cancelled') {
        setNotice('Nothing changed: the unlock check was cancelled.');
      }
    });

  return (
    <SettingsSection
      title="App lock"
      description="Ask for your face, fingerprint or device passcode before showing your memory."
      help="Captures and sync keep running behind the lock; only the screen is covered."
    >
      <SettingsGroup>
        <SettingsRow
          label="Require unlock"
          htmlFor="app-lock-enabled"
          hint={
            <>
              {describeBiometry(status.biometry)}
              {!status.available && status.reason ? (
                <span className="mt-1 block text-destructive">{status.reason}</span>
              ) : null}
            </>
          }
          control={
            <Switch
              id="app-lock-enabled"
              checked={status.enabled}
              disabled={busy || (!status.enabled && !status.available)}
              onCheckedChange={(checked) => void toggleEnabled(checked)}
            />
          }
        />

        {notice ? (
          <SettingsRow>
            <SettingsStatus>{notice}</SettingsStatus>
          </SettingsRow>
        ) : null}

        <SettingsRow
          label="Lock again"
          htmlFor="app-lock-grace"
          hint={APP_LOCK_GRACE_LABELS[status.grace].hint}
        >
          <Select
            value={status.grace}
            disabled={busy || !status.enabled}
            onValueChange={(value) => void change({ grace: value as AppLockGrace })}
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
        </SettingsRow>

        {/* Android only: FLAG_SECURE is a real choice there. iOS always blurs the app in
            the switcher while the lock is on and has no screenshot block, so a switch
            would do nothing and is not shown. */}
        {isAndroidPlatform() && (
          <SettingsRow
            label="Hide in app switcher and prevent screenshots"
            htmlFor="app-lock-secure"
            hint="Shows a blank card in recent apps and blocks screenshots and screen recording, including your own."
            control={
              <Switch
                id="app-lock-secure"
                checked={status.secureScreen}
                disabled={busy || !status.enabled}
                onCheckedChange={(checked) => void change({ secureScreen: checked })}
              />
            }
          />
        )}

        <SettingsFooter>
          <Button variant="outline" disabled={busy || !status.enabled} onClick={() => void run(lock)}>
            Lock now
          </Button>
        </SettingsFooter>
      </SettingsGroup>
    </SettingsSection>
  );
}
