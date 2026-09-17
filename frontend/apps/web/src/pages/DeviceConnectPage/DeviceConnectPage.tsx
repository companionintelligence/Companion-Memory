import { useEffect, useState } from 'react';

import { isIosPlatform, persistApiBaseUrl, resolveHttpOrigin } from '@ci/common';
import { Button, Card, LoadingButton } from '@ci/shadcn';
import { useNavigate } from 'react-router-dom';

import { ThemeToggle } from '@/components/ThemePicker';
import { useAuth, useCurrentUser } from '@/hooks';
import { BrainMark, CONNECT_MARK_SIZE, Reveal, SplashShell } from '@/pages/SplashPage/SplashChrome';

import {
  loginWithPortalOidc,
  OidcCancelledError,
  resumePendingOidcLogin,
  selectMemoryPortalBearers,
} from './oidc';
import {
  listMemoryServers,
  probeMemoryOrigin,
  readPersistedPortalUrl,
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
 * Native-only Hub-style picker: Portal OIDC in the *system* browser (Safari /
 * `companion://auth/callback`), list `ci-memory` apps, persist that origin, then
 * mint a Memory key from the Companion token. A Memory URL or email/password
 * cannot cloud-connect a new phone — those live under Advanced as Hub URL /
 * offline unlock. Named `/device-connect` because `/connect` already means Sources.
 */
export function DeviceConnectPage() {
  const navigate = useNavigate();
  const [{ authenticated, initializing }, { completePortalMemoryConnect }] = useAuth();
  const { user, loading: userLoading, error: userError } = useCurrentUser();

  // Do not leave this page until Memory has accepted the minted key and `me`
  // resolved. Navigating to `/` earlier makes RedirectKnownUser treat a missing
  // profile as "logged out" and bounce straight back here.
  const [step, setStep] = useState<Step>('sign-in');
  const [portalUrl] = useState(readPersistedPortalUrl);
  const [auth, setAuth] = useState<PortalAuth | null>(null);
  const [devices, setDevices] = useState<MemoryServerDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [oidcController, setOidcController] = useState<AbortController | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
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

    try {
      const origin = resolveHttpOrigin(device.memoryUrl);
      await probeMemoryOrigin(origin);

      const rawBearers =
        auth?.kind === 'oauth'
          ? [auth.idToken, auth.token].filter((value): value is string => Boolean(value))
          : [];
      const bearers = selectMemoryPortalBearers(rawBearers);

      if (rawBearers.length === 0) {
        setSignInError('Sign in with your Companion account first, then pick this server again.');
        setConnectingId(null);

        return;
      }

      if (bearers.length === 0) {
        setSignInError('Your Companion sign-in expired. Sign in again.');
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
      const unauthorized = /unauthorized/i.test(err instanceof Error ? err.message : '');

      setSignInError(
        err instanceof Error && err.name === 'AbortError'
          ? 'Could not reach your Companion Memory (timed out).'
          : /load failed|failed to fetch/i.test(err instanceof Error ? err.message : '')
            ? 'Could not reach this Memory Server from the phone (webview blocked the request). Retry after the app reloads native HTTP.'
            : unauthorized
              ? 'This Memory Server is online, but it did not accept your Companion account. Sign in again.'
              : `Could not sign in to ${device.memoryUrl}. ${err instanceof Error ? err.message : ''}`.trim(),
      );

      setConnectingId(null);
    }
  };

  if (step === 'sign-in') {
    return (
      <SplashShell>
        <div className="relative z-10 flex h-full flex-col items-center justify-center gap-5 overflow-y-auto px-8 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]">
          <Reveal delay={0} className="flex shrink-0 flex-col items-center">
            <BrainMark sizeClass={CONNECT_MARK_SIZE} />
            <p className="-mt-3 text-sm font-semibold tracking-[0.2em] text-muted-foreground uppercase">
              Companion Memory
            </p>
          </Reveal>

          <Reveal delay={180} className="flex w-full max-w-sm flex-col items-center gap-3">
            <LoadingButton
              type="button"
              size="lg"
              className={`w-full px-10 shadow-glow-ci ${TOUCH}`}
              onClick={() => void handleOidcLogin()}
              loading={busy}
              disabled={busy}
              data-testid="oidc-login-btn"
            >
              Log in
            </LoadingButton>

            {signInError ? (
              <p
                className="text-destructive text-center text-sm"
                data-testid="connect-signin-error"
                role="alert"
              >
                {signInError}
              </p>
            ) : null}

            {oidcController ? (
              <div className="flex flex-col items-center gap-2 text-center text-xs text-muted-foreground">
                <span>
                  Finish signing in in {isIosPlatform() ? 'Safari' : 'your browser'}, then return to this app.
                </span>
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
              <button
                type="button"
                className="text-muted-foreground py-2 text-xs underline"
                onClick={() => navigate('/device-connect/advanced')}
                data-testid="advanced-link"
              >
                Advanced
              </button>
            )}
          </Reveal>
        </div>
      </SplashShell>
    );
  }

  return (
    <div className="safe-area-inset flex min-h-dvh w-full flex-col overflow-y-auto px-6 pb-6">
      <div className="flex justify-end">
        <ThemeToggle />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center">
        <div className="w-full max-w-md">
          <Card>
            <Card.Header>
              <Card.Title>Pick a Memory Server</Card.Title>
              <Card.Description>
                Choose the Companion Memory instance this phone should talk to.
              </Card.Description>
            </Card.Header>

            <Card.Content>
              <div className="flex flex-col gap-3">
                {devices.length === 0 ? (
                  <p className="text-muted-foreground py-6 text-center text-sm">
                    No Memory Servers on this account. Install Companion Memory on your Hub, then Refresh.
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
                <Button
                  type="button"
                  variant="ghost"
                  className={TOUCH}
                  onClick={() => navigate('/device-connect/advanced')}
                >
                  Advanced
                </Button>
              </div>
            </Card.Content>
          </Card>
        </div>
      </div>
    </div>
  );
}
