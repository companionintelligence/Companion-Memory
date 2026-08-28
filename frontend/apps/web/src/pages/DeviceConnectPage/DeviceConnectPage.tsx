import { type FormEvent, useEffect, useState } from 'react';

import { persistApiBaseUrl, resolveHttpOrigin } from '@ci/common';
import { Button, Card, Input, LoadingButton, PasswordInput } from '@ci/shadcn';
import { useNavigate } from 'react-router-dom';

import { useAuth, useCurrentUser } from '@/hooks';

import {
  emailFromIdToken,
  loginWithPortalOidc,
  OidcCancelledError,
  resumePendingOidcLogin,
  selectMemoryPortalBearers,
} from './oidc';
import {
  DEFAULT_PORTAL_URL,
  listMemoryServers,
  probeMemoryOrigin,
  signInToPortal,
  type MemoryServerDevice,
  type PortalAuth,
} from './portal-client';

type Step = 'sign-in' | 'pick';

const TOUCH = 'min-h-[44px]';
const PORTAL_AUTH_KEY = 'ci.deviceConnect.portalAuth';

function writePortalAuth(auth: PortalAuth): void {
  try {
    sessionStorage.setItem(PORTAL_AUTH_KEY, JSON.stringify(auth));
  } catch {
    /* ignore */
  }
}

function readStoredPortalAuth(): PortalAuth | null {
  try {
    const raw = sessionStorage.getItem(PORTAL_AUTH_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as PortalAuth;

    if (parsed.kind === 'oauth' && (parsed.token || parsed.idToken)) {
      return parsed;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Native-only Hub-style picker: Portal OIDC (system browser + companion://auth/callback)
 * or email, list `ci-memory` apps, persist that origin, then hand off to Memory login.
 * Named `/device-connect` because `/connect` already means Sources.
 */
export function DeviceConnectPage() {
  const navigate = useNavigate();
  const [{ authenticated, initializing }, { completePortalMemoryConnect, completeMemoryPasswordConnect }] =
    useAuth();
  const { user, loading: userLoading, error: userError } = useCurrentUser();

  // Do not leave this page until Memory has accepted the minted key and `me`
  // resolved. Navigating to `/` earlier makes RedirectKnownUser treat a missing
  // profile as "logged out" and bounce straight back here.
  const [step, setStep] = useState<Step>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [portalUrl, setPortalUrl] = useState(DEFAULT_PORTAL_URL);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [auth, setAuth] = useState<PortalAuth | null>(null);
  const [devices, setDevices] = useState<MemoryServerDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [oidcController, setOidcController] = useState<AbortController | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [memoryLoginOrigin, setMemoryLoginOrigin] = useState<string | null>(null);
  const [memoryEmail, setMemoryEmail] = useState('');
  const [memoryPassword, setMemoryPassword] = useState('');
  const [awaitingProfile, setAwaitingProfile] = useState(false);

  useEffect(() => {
    if (!initializing && authenticated && user) {
      navigate('/', { replace: true });
    }
  }, [authenticated, initializing, navigate, user]);

  useEffect(() => {
    if (!awaitingProfile || connectingId == null || initializing || userLoading || !authenticated || user) {
      return;
    }

    setSignInError(
      userError instanceof Error
        ? userError.message
        : 'Signed in but could not load your profile from this Memory Server.',
    );
    setConnectingId(null);
    setAwaitingProfile(false);
  }, [authenticated, awaitingProfile, connectingId, initializing, user, userError, userLoading]);

  // Safari → "Open with Companion" often cold-starts the app. PKCE state lives in
  // localStorage; Capacitor stashed the callback URL. Finish the exchange on mount
  // and when we become visible again.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const finish = async () => {
      if (cancelled || inFlight) {
        return;
      }

      inFlight = true;

      try {
        const tokens = await resumePendingOidcLogin();
        const stored = tokens ? null : readStoredPortalAuth();

        if (cancelled || (!tokens && !stored)) {
          return;
        }

        setBusy(true);
        setSignInError(null);
        const portalAuth: PortalAuth = tokens
          ? {
              token: tokens.accessToken,
              idToken: tokens.idToken,
              cookie: null,
              kind: 'oauth',
            }
          : stored!;
        writePortalAuth(portalAuth);
        setAuth(portalAuth);
        const servers = await listMemoryServers(portalAuth, portalUrl);

        if (cancelled) {
          return;
        }

        setDevices(servers);
        setStep('pick');
      } catch (err) {
        if (!cancelled && !(err instanceof OidcCancelledError)) {
          const message = err instanceof Error ? err.message : 'Sign-in failed';

          if (/invalid.?code|invalid_grant/i.test(message)) {
            return;
          }

          setSignInError(message);
        }
      } finally {
        inFlight = false;

        if (!cancelled) {
          setBusy(false);
        }
      }
    };

    void finish();
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void finish();
      }
    };

    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [portalUrl]);

  const loadDevices = async (portalAuth: PortalAuth) => {
    writePortalAuth(portalAuth);
    setAuth(portalAuth);
    const servers = await listMemoryServers(portalAuth, portalUrl);
    setDevices(servers);
    setStep('pick');
  };

  const handleSignIn = async (event: FormEvent) => {
    event.preventDefault();

    if (!email || !password) {
      return;
    }

    setBusy(true);
    setSignInError(null);

    try {
      await loadDevices(await signInToPortal(email, password, portalUrl));
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  const handleOidcLogin = async () => {
    const controller = new AbortController();
    setOidcController(controller);
    setBusy(true);
    setSignInError(null);

    try {
      const tokens = await loginWithPortalOidc(portalUrl, { signal: controller.signal });
      await loadDevices({
        token: tokens.accessToken,
        idToken: tokens.idToken,
        cookie: null,
        kind: 'oauth',
      });
    } catch (err) {
      if (!(err instanceof OidcCancelledError)) {
        setSignInError(err instanceof Error ? err.message : 'Sign-in failed');
      }
    } finally {
      setBusy(false);
      setOidcController(null);
    }
  };

  const handleRefresh = async () => {
    if (!auth) {
      return;
    }

    setBusy(true);
    setSignInError(null);

    try {
      setDevices(await listMemoryServers(auth, portalUrl));
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : 'Could not refresh Memory Servers.');
    } finally {
      setBusy(false);
    }
  };

  const handleConnect = async (device: MemoryServerDevice) => {
    if (!device.memoryUrl) {
      return;
    }

    setConnectingId(device.id);
    setSignInError(null);
    setMemoryLoginOrigin(null);

    try {
      const origin = resolveHttpOrigin(device.memoryUrl);
      await probeMemoryOrigin(origin);

      const rawBearers =
        auth?.kind === 'oauth'
          ? [auth.idToken, auth.token].filter((value): value is string => Boolean(value))
          : [];
      const bearers = selectMemoryPortalBearers(rawBearers);

      if (rawBearers.length === 0) {
        setSignInError('Sign in with Companion Intelligence first, then pick this server again.');
        setConnectingId(null);

        return;
      }

      if (bearers.length === 0) {
        setSignInError(
          'Your Companion Intelligence sign-in expired. Sign in again, or use the Memory email and password from the browser.',
        );
        setMemoryLoginOrigin(origin);
        setMemoryEmail(emailFromIdToken(auth?.idToken) ?? '');
        setConnectingId(null);

        return;
      }

      // Mint against the picked Memory origin. Apply it in memory first so
      // CapacitorHttp never sees a relative `/api/graphql`. Persist on success
      // only — a leftover origin with no key used to skip cloud-connect.
      let lastError: unknown;

      for (const bearer of bearers) {
        try {
          await completePortalMemoryConnect(bearer, origin);
          persistApiBaseUrl(origin);
          setAwaitingProfile(true);

          return;
        } catch (err) {
          lastError = err;
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new Error('Could not sign in to this Memory Server with your Portal account.');
    } catch (err) {
      const origin = (() => {
        try {
          return resolveHttpOrigin(device.memoryUrl);
        } catch {
          return null;
        }
      })();
      const unauthorized = /unauthorized/i.test(err instanceof Error ? err.message : '');

      setSignInError(
        err instanceof Error && err.name === 'AbortError'
          ? 'Could not reach your Companion Memory (timed out).'
          : /load failed|failed to fetch/i.test(err instanceof Error ? err.message : '')
            ? 'Could not reach this Memory Server from the phone (webview blocked the request). Retry after the app reloads native HTTP.'
            : unauthorized
              ? 'This Memory Server is online, but it did not accept your Companion Intelligence token. Sign in with the email and password you use in the browser.'
              : `Could not sign in to ${device.memoryUrl}. ${err instanceof Error ? err.message : ''}`.trim(),
      );
      if (unauthorized && origin) {
        setMemoryLoginOrigin(origin);
        setMemoryEmail(emailFromIdToken(auth?.idToken) ?? '');
      }

      setConnectingId(null);
    }
  };

  const handleMemoryPassword = async (event: FormEvent) => {
    event.preventDefault();

    if (!memoryLoginOrigin || !memoryEmail || !memoryPassword) {
      return;
    }

    setBusy(true);
    setSignInError(null);

    try {
      await completeMemoryPasswordConnect(memoryEmail, memoryPassword, memoryLoginOrigin);
      setAwaitingProfile(true);
    } catch (err) {
      setSignInError(
        err instanceof Error ? err.message : 'Could not sign in to this Memory Server with that password.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-md">
      <Card>
        <Card.Header>
          <Card.Title>{step === 'sign-in' ? 'Connect to your Memory' : 'Pick a Memory Server'}</Card.Title>
          <Card.Description>
            {step === 'sign-in'
              ? 'Sign in to your Companion Intelligence account to find the Memory Servers you own.'
              : 'Choose the Companion Memory instance this phone should talk to.'}
          </Card.Description>
        </Card.Header>

        <Card.Content>
          {step === 'sign-in' ? (
            <div className="flex flex-col gap-4">
              <LoadingButton
                type="button"
                className={TOUCH}
                onClick={() => void handleOidcLogin()}
                loading={busy}
                disabled={busy}
                data-testid="oidc-login-btn"
              >
                Sign in with Companion Intelligence
              </LoadingButton>
              {signInError ? (
                <p className="text-destructive text-sm" data-testid="connect-signin-error" role="alert">
                  {signInError}
                </p>
              ) : null}

              {oidcController ? (
                <div className="bg-muted/40 flex flex-col items-center gap-2 rounded-md p-3 text-center text-xs text-muted-foreground">
                  <span>Finish signing in in your browser, then return to this app.</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={TOUCH}
                    onClick={() => oidcController.abort()}
                    data-testid="cancel-oidc-btn"
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <>
                  <div className="text-muted-foreground flex items-center gap-3 text-xs">
                    <span className="bg-border h-px flex-1" />
                    or use email
                    <span className="bg-border h-px flex-1" />
                  </div>
                  <form onSubmit={handleSignIn} className="flex flex-col gap-4">
                    <Input
                      type="email"
                      className={TOUCH}
                      aria-label="Email"
                      placeholder="you@example.com"
                      autoComplete="username"
                      inputMode="email"
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
                    {showAdvanced ? (
                      <Input
                        type="url"
                        className={TOUCH}
                        aria-label="Portal URL"
                        placeholder="Portal URL"
                        inputMode="url"
                        value={portalUrl}
                        onChange={(e) => setPortalUrl(e.target.value)}
                      />
                    ) : (
                      <button
                        type="button"
                        className={`text-muted-foreground self-start py-2 text-xs underline ${TOUCH}`}
                        onClick={() => setShowAdvanced(true)}
                      >
                        Advanced
                      </button>
                    )}
                    <LoadingButton
                      type="submit"
                      variant="outline"
                      className={TOUCH}
                      loading={busy}
                      disabled={busy || !email || !password}
                    >
                      Sign in with email
                    </LoadingButton>
                  </form>
                </>
              )}
              <Button
                type="button"
                variant="ghost"
                className={`w-full ${TOUCH}`}
                onClick={() => navigate('/server')}
              >
                Enter a Memory Server URL instead
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {devices.length === 0 ? (
                <p className="text-muted-foreground py-6 text-center text-sm">
                  No Memory Servers on this account. Install Companion Memory on your Hub, or enter a URL.
                </p>
              ) : (
                devices.map((device) => {
                  const reachable = Boolean(device.memoryUrl);
                  const active = reachable && device.status === 'active';

                  return (
                    <button
                      key={device.id}
                      type="button"
                      disabled={connectingId !== null || !reachable}
                      onClick={() => void handleConnect(device)}
                      data-testid={`memory-row-${device.id}`}
                      className="border-input flex min-h-[56px] items-center justify-between gap-3 rounded-md border p-4 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">{device.name}</div>
                        <div className="text-muted-foreground truncate text-xs">
                          {device.memoryUrl ?? 'No address published'}
                        </div>
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-sm ${active ? 'bg-green-500/15 text-green-600 dark:text-green-400' : 'bg-muted text-foreground/80'}`}
                      >
                        {connectingId === device.id
                          ? 'Connecting…'
                          : reachable
                            ? device.status
                            : 'unreachable'}
                      </span>
                    </button>
                  );
                })
              )}
              {signInError ? (
                <p className="text-destructive text-sm" data-testid="connect-signin-error" role="alert">
                  {signInError}
                </p>
              ) : null}
              {memoryLoginOrigin ? (
                <form onSubmit={(event) => void handleMemoryPassword(event)} className="flex flex-col gap-3">
                  <Input
                    type="email"
                    className={TOUCH}
                    aria-label="Memory email"
                    placeholder="Memory email"
                    autoComplete="username"
                    inputMode="email"
                    value={memoryEmail}
                    onChange={(e) => setMemoryEmail(e.target.value)}
                    required
                    data-testid="memory-email"
                  />
                  <PasswordInput
                    className={TOUCH}
                    aria-label="Memory password"
                    placeholder="Memory password"
                    autoComplete="current-password"
                    value={memoryPassword}
                    onChange={(e) => setMemoryPassword(e.target.value)}
                    required
                    data-testid="memory-password"
                  />
                  <LoadingButton
                    type="submit"
                    className={TOUCH}
                    loading={busy}
                    disabled={busy || !memoryEmail || !memoryPassword}
                    data-testid="memory-password-submit"
                  >
                    Sign in to this Memory Server
                  </LoadingButton>
                </form>
              ) : null}
              <div className="mt-2 flex items-center justify-between">
                <Button
                  variant="ghost"
                  size="sm"
                  className={TOUCH}
                  onClick={() => setStep('sign-in')}
                  disabled={connectingId !== null}
                >
                  Back
                </Button>
                <LoadingButton
                  type="button"
                  variant="outline"
                  size="sm"
                  className={TOUCH}
                  onClick={() => void handleRefresh()}
                  loading={busy}
                  disabled={busy || connectingId !== null}
                >
                  Refresh
                </LoadingButton>
              </div>
              <Button type="button" variant="ghost" className={TOUCH} onClick={() => navigate('/server')}>
                Enter a URL instead
              </Button>
            </div>
          )}
        </Card.Content>
      </Card>
    </div>
  );
}
