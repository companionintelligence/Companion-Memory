import { type FormEvent, useState } from 'react';

import { getApiBaseUrl, isIosPlatform, isLocalApplianceOrigin } from '@ci/common';
import { Button, Card, EmailInput, Input, Label, LoadingButton, PasswordInput } from '@ci/shadcn';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '@/hooks';
import {
  persistPortalUrl,
  readPersistedPortalUrl,
  DEFAULT_PORTAL_URL,
} from '@/pages/DeviceConnectPage/portal-client';

const TOUCH = 'min-h-[44px]';

/**
 * Advanced pairing settings. Not a connect path.
 *
 * A Memory Server URL cannot pair this phone: pairing mints a Memory API key from
 * a Companion (Portal) OIDC token after Log in. Typing an origin used to persist
 * that URL with no key and bounce back to the splash — it never authenticated.
 *
 * Email/password here talks to Memory `/api/authenticate` on an origin this phone
 * already paired. It unlocks offline SQLite. It cannot list Hub devices or attach
 * a new box.
 */
export function ServerSettingsPage() {
  const navigate = useNavigate();
  const [, { completeMemoryPasswordConnect }] = useAuth();

  const [portalUrl, setPortalUrl] = useState(readPersistedPortalUrl);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const origin = getApiBaseUrl();
  const canOfflineUnlock = Boolean(origin) && !isLocalApplianceOrigin(origin);

  const handleSavePortal = (event: FormEvent) => {
    event.preventDefault();
    persistPortalUrl(portalUrl);
    navigate('/device-connect');
  };

  const handleUnlock = async (event: FormEvent) => {
    event.preventDefault();

    if (!canOfflineUnlock || !email || !password) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await completeMemoryPasswordConnect(email, password, origin);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlock this Memory.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-sm">
      <Card>
        <Card.Header>
          <Card.Title>Advanced</Card.Title>
          <Card.Description>
            Connecting a new phone requires Log in with your Companion account. These settings only change
            which Hub that uses, or unlock a Memory this phone already paired.
          </Card.Description>
        </Card.Header>

        <Card.Content className="flex flex-col gap-6">
          <form onSubmit={handleSavePortal} className="flex flex-col gap-3">
            <div className="space-y-2">
              <Label htmlFor="portal-url">Companion URL</Label>
              <Input
                id="portal-url"
                type="url"
                className={TOUCH}
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                placeholder={DEFAULT_PORTAL_URL}
                value={portalUrl}
                onChange={(e) => setPortalUrl(e.target.value)}
                aria-label="Companion URL"
              />
              <p className="text-muted-foreground text-xs">
                {isIosPlatform() ? 'Safari' : 'Your browser'} signs in here. Then the app lists Memory Servers
                on this account.
              </p>
            </div>
            <LoadingButton type="submit" variant="outline" className={TOUCH}>
              Save URL
            </LoadingButton>
          </form>

          <div className="space-y-2">
            <p className="text-sm font-medium">Memory origin</p>
            <p className="text-muted-foreground text-xs" data-testid="memory-origin-hint">
              {canOfflineUnlock
                ? origin
                : 'Not paired yet. A URL by itself cannot connect this phone — Log in sends the Companion token the box needs.'}
            </p>
          </div>

          {canOfflineUnlock ? (
            <form onSubmit={(event) => void handleUnlock(event)} className="flex flex-col gap-3">
              <p className="text-muted-foreground text-xs">
                Sign in with email and pass unlocks this already-paired Memory when you are offline. It does
                not connect a new device.
              </p>
              <EmailInput
                className={TOUCH}
                aria-label="Email"
                placeholder="you@example.com"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <PasswordInput
                className={TOUCH}
                aria-label="Password"
                placeholder="Password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              {error ? (
                <p className="text-destructive text-sm" role="alert">
                  {error}
                </p>
              ) : null}
              <LoadingButton
                type="submit"
                className={TOUCH}
                loading={busy}
                disabled={busy || !email || !password}
                data-testid="local-unlock-submit"
              >
                Unlock
              </LoadingButton>
            </form>
          ) : null}

          <Button
            type="button"
            variant="ghost"
            className={`w-full ${TOUCH}`}
            onClick={() => navigate('/device-connect')}
          >
            Back to Log in
          </Button>
        </Card.Content>
      </Card>
    </div>
  );
}
