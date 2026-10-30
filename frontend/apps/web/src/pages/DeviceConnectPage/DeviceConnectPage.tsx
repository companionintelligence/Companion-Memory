import { useEffect, useRef, useState } from 'react';

import { isIosPlatform, LoadingPage, persistApiBaseUrl, resolveHttpOrigin } from '@ci/common';
import { Button, Card, LoadingButton } from '@ci/shadcn';
import { useNavigate } from 'react-router-dom';

import { ThemeToggle } from '@/components/ThemePicker';
import { useAuth, useCurrentUser } from '@/hooks';
import { BrainMark, CONNECT_MARK_SIZE, Reveal, SplashShell } from '@/pages/SplashPage/SplashChrome';

import {
  bearerAddressedTo,
  dropPendingPick,
  emailFromIdToken,
  exchangePortalSignIn,
  forgetPortalSignIn,
  OidcCancelledError,
  resumePendingOidcLogin,
  selectMemoryPortalBearers,
  signInWithPortalOidc,
  type OidcTokens,
  type PairingTarget,
  type PortalSignIn,
} from './oidc';
import {
  DEFAULT_PORTAL_URL,
  listMemoryServers,
  listMemoryServersByCode,
  PortalSignInExpiredError,
  probeMemoryOrigin,
  probePortalOrigin,
  readPersistedPortalUrl,
  type MemoryServerDevice,
  type PortalAuth,
} from './portal-client';

type Step = 'sign-in' | 'pick';

const TOUCH = 'min-h-[44px]';
const PORTAL_AUTH_KEY = 'ci.deviceConnect.portalAuth';

/**
 * What Log in says when the Companion server does not answer. The two cases
 * need different advice: the default host being down is the connection's
 * problem, a custom one is most likely a mistyped Advanced setting.
 */
function portalUnreachableMessage(portalUrl: string): string {
  return portalUrl === DEFAULT_PORTAL_URL
    ? `Could not reach the Companion server (${portalUrl}). Check your connection and try again.`
    : `Could not reach the Companion server at ${portalUrl}. Check the Companion URL under Advanced.`;
}

function writePortalAuth(auth: PortalAuth): void {
  const raw = JSON.stringify(auth);

  try {
    sessionStorage.setItem(PORTAL_AUTH_KEY, raw);
  } catch {
    /* ignore */
  }

  // sessionStorage dies when iOS reclaims the webview. The Portal token has to
  // outlive that, or the next launch forgets who just signed in.
  try {
    localStorage.setItem(PORTAL_AUTH_KEY, raw);
  } catch {
    /* ignore */
  }
}

function clearStoredPortalAuth(): void {
  try {
    sessionStorage.removeItem(PORTAL_AUTH_KEY);
  } catch {
    /* ignore */
  }

  try {
    localStorage.removeItem(PORTAL_AUTH_KEY);
  } catch {
    /* ignore */
  }
}

function readStoredPortalAuth(): PortalAuth | null {
  try {
    const raw = sessionStorage.getItem(PORTAL_AUTH_KEY) ?? localStorage.getItem(PORTAL_AUTH_KEY);

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
 * mint a Memory key from the Companion token. A Portal that lists by code keeps
 * the sign-in's code unspent while the person picks, then spends it on the pick
 * for an id_token addressed to that Memory alone. A Memory URL or email/password
 * cannot cloud-connect a new phone — those live under Advanced as Hub URL /
 * offline unlock. Named `/device-connect` because `/connect` already means Sources.
 */
export function DeviceConnectPage() {
  const navigate = useNavigate();
  const [{ authenticated, initializing }, { completePortalMemoryConnect }] = useAuth();
  const { user, loading: userLoading, error: userError, refetch } = useCurrentUser();

  // Do not leave this page until Memory has accepted the minted key and `me`
  // resolved. Navigating to `/` earlier makes RedirectKnownUser treat a missing
  // profile as "logged out" and bounce straight back here.
  const [step, setStep] = useState<Step>('sign-in');
  const [portalUrl] = useState(readPersistedPortalUrl);
  // An older Portal's tokens: the list comes with the access token, pairing sends the id_token.
  const [auth, setAuth] = useState<PortalAuth | null>(null);
  // A Portal that lists by code: the sign-in, its code unspent until a Memory is picked.
  const [signIn, setSignIn] = useState<PortalSignIn | null>(null);
  const [devices, setDevices] = useState<MemoryServerDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [oidcController, setOidcController] = useState<AbortController | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [awaitingProfile, setAwaitingProfile] = useState(false);
  // A pick iOS killed the app in the middle of, waiting for this render's handleConnect.
  const [resumedPick, setResumedPick] = useState<{ device: PairingTarget; signIn: PortalSignIn } | null>(
    null,
  );
  const accountEmail = emailFromIdToken(auth?.idToken);
  // `me` can already be sitting on Unauthorized from the previous box's key.
  // That object must not be reported as the result of this tap.
  const profileErrorBeforeConnect = useRef<unknown>(null);
  // Set while handleConnect runs. A resume on a warm return finds the same sign-in and pick, and
  // only one of the two may pair.
  const connectInFlight = useRef(false);
  // Counts handleConnect runs. A resume that began before the latest one read storage from before
  // that pick: whatever it found, the pick owns the sign-in now.
  const connectRuns = useRef(0);

  /** The sign-in can't open anything any more: back to Log in, saying why. */
  const signInAgain = (message: string) => {
    void forgetPortalSignIn();
    setSignIn(null);
    setAuth(null);
    setDevices([]);
    setStep('sign-in');
    setSignInError(message);
  };

  useEffect(() => {
    if (!initializing && authenticated && user) {
      navigate('/', { replace: true });
    }
  }, [authenticated, initializing, navigate, user]);

  useEffect(() => {
    if (
      !awaitingProfile ||
      connectingId == null ||
      initializing ||
      userLoading ||
      !authenticated ||
      user ||
      (userError != null && userError === profileErrorBeforeConnect.current)
    ) {
      return;
    }

    const message =
      userError instanceof Error
        ? userError.message
        : 'Signed in but could not load your profile from this Memory Server.';

    setConnectingId(null);
    setAwaitingProfile(false);

    // An older Portal's id_token can be sent again. A code spent on the pick can't: like every
    // other failure after the spend, this one needs a new sign-in.
    if (auth) {
      setSignInError(message);
    } else {
      signInAgain(message);
    }
  }, [auth, authenticated, awaitingProfile, connectingId, initializing, user, userError, userLoading]);

  // Storing the new key flips `authenticated`, and PowerSyncBoundary (App.tsx) then mounts
  // the sync provider above every route. React remounts the whole tree, this page included,
  // so a pairing that has just finished comes back here with a fresh `step` of 'sign-in'
  // while `me` is still loading. That wait used to show Log in for about a second. A pick
  // running in this instance keeps its own "Connecting…" row instead.
  const mountedMidSignIn = useRef(authenticated && !user && userLoading);
  const profileErrorAtMount = useRef(userError);
  const finishingSignIn = authenticated && !user && userLoading && connectingId == null && !awaitingProfile;

  // The remount also dropped the instance that would have said why `me` failed. A failure
  // that was already there before the remount is the previous key's, not this sign-in's.
  useEffect(() => {
    if (!mountedMidSignIn.current || userLoading || user || connectingId != null || awaitingProfile) {
      return;
    }

    mountedMidSignIn.current = false;

    if (userError != null && userError !== profileErrorAtMount.current) {
      setSignInError(
        userError instanceof Error
          ? userError.message
          : 'Signed in but could not load your profile from this Memory Server.',
      );
    }
  }, [awaitingProfile, connectingId, user, userError, userLoading]);

  // Safari → "Open with Companion" often cold-starts the app. PKCE state lives in
  // localStorage; Capacitor stashed the callback URL. Pick the sign-in up on mount
  // and when we become visible again: list by its code, or finish the pick iOS
  // killed the app in the middle of.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const finish = async () => {
      // While handleConnect runs it owns the sign-in, and a resume would only race it.
      if (cancelled || inFlight || connectInFlight.current) {
        return;
      }

      inFlight = true;
      const runsAtStart = connectRuns.current;
      const pickStartedSince = () => connectRuns.current !== runsAtStart;

      try {
        const resumed = await resumePendingOidcLogin();

        if (cancelled || pickStartedSince()) {
          return;
        }

        if (resumed?.pick) {
          // Pair with the Memory that was picked, rather than showing the list again.
          dropPendingPick();
          setAuth(null);
          setSignIn(resumed.signIn);
          setDevices([resumed.pick]);
          setStep('pick');
          setResumedPick({ device: resumed.pick, signIn: resumed.signIn });

          return;
        }

        if (resumed) {
          setBusy(true);
          setSignInError(null);
          await listForSignIn(resumed.signIn, () => cancelled);

          return;
        }

        // An older Portal's sign-in, kept from before.
        const stored = readStoredPortalAuth();

        if (!stored) {
          return;
        }

        setBusy(true);
        setSignInError(null);
        writePortalAuth(stored);
        setAuth(stored);
        const servers = await listMemoryServers(stored, portalUrl);

        if (cancelled) {
          return;
        }

        setDevices(servers);
        setStep('pick');
      } catch (err) {
        // A pick that started meanwhile owns the sign-in and reports its own outcome.
        if (cancelled || err instanceof OidcCancelledError || pickStartedSince()) {
          return;
        }

        if (err instanceof PortalSignInExpiredError) {
          signInAgain(err.message);

          return;
        }

        const message = err instanceof Error ? err.message : 'Sign-in failed';

        if (/invalid.?code|invalid_grant/i.test(message)) {
          return;
        }

        setSignInError(message);
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

  const loadDevices = async (portalAuth: PortalAuth, portal = portalUrl) => {
    writePortalAuth(portalAuth);
    setAuth(portalAuth);
    const servers = await listMemoryServers(portalAuth, portal);
    setDevices(servers);
    setStep('pick');
  };

  /**
   * List the Memories for a sign-in whose code is not spent yet. A Portal that lists by code keeps
   * the code for the pick, and nothing is stored but the sign-in itself. An older Portal answers
   * 404, so the code is exchanged now and the list comes with the access token, as before.
   *
   * Always at the Portal that issued the code (`held.portal`), never the Companion URL as it reads
   * now: Advanced can change that while the sign-in is held, and the code with its verifier is
   * enough to redeem it.
   */
  async function listForSignIn(held: PortalSignIn, isCancelled: () => boolean = () => false): Promise<void> {
    const servers = await listMemoryServersByCode(held, held.portal);

    if (servers === null) {
      const tokens = await exchangePortalSignIn(held);
      const portalAuth: PortalAuth = {
        token: tokens.accessToken,
        idToken: tokens.idToken,
        cookie: null,
        kind: 'oauth',
      };

      if (isCancelled()) {
        // The code is spent and the sign-in dropped: keep the tokens, so the next mount lists
        // with them instead of asking for a new sign-in.
        writePortalAuth(portalAuth);
      } else {
        await loadDevices(portalAuth, held.portal);
      }

      return;
    }

    if (isCancelled()) {
      return;
    }

    setAuth(null);
    setSignIn(held);
    setDevices(servers);
    setStep('pick');
  }

  const handleOidcLogin = async () => {
    // The picker restores whatever Portal token is still in this tab. Drop it
    // before the sheet opens so a cancelled switch cannot snap back to it.
    clearStoredPortalAuth();
    setAuth(null);
    setSignIn(null);
    setBusy(true);
    setSignInError(null);

    try {
      // Before the sheet opens: an unreachable Companion URL would otherwise
      // show up only inside it, as a browser error page that dismisses silently.
      try {
        await probePortalOrigin(portalUrl);
      } catch {
        setSignInError(portalUnreachableMessage(portalUrl));

        return;
      }

      // Created only once the sheet is really about to open — the "finish
      // signing in" hint and its Cancel belong to the sheet, not to the probe.
      const controller = new AbortController();
      setOidcController(controller);

      const held = await signInWithPortalOidc(portalUrl, { signal: controller.signal });
      await listForSignIn(held);
    } catch (err) {
      if (err instanceof PortalSignInExpiredError) {
        void forgetPortalSignIn();
      }

      if (!(err instanceof OidcCancelledError)) {
        setSignInError(err instanceof Error ? err.message : 'Sign-in failed');
      }
    } finally {
      setBusy(false);
      setOidcController(null);
    }
  };

  const handleRefresh = async () => {
    if (!signIn && !auth) {
      return;
    }

    setBusy(true);
    setSignInError(null);

    try {
      if (signIn) {
        // Listed by the same unspent code, which the Portal still takes until it expires.
        const servers = await listMemoryServersByCode(signIn, signIn.portal);

        if (servers === null) {
          throw new Error('Could not refresh Memory Servers.');
        }

        setDevices(servers);
      } else if (auth) {
        setDevices(await listMemoryServers(auth, portalUrl));
      }
    } catch (err) {
      if (err instanceof PortalSignInExpiredError) {
        signInAgain(err.message);

        return;
      }

      setSignInError(err instanceof Error ? err.message : 'Could not refresh Memory Servers.');
    } finally {
      setBusy(false);
    }
  };

  const handleConnect = async (device: MemoryServerDevice, held: PortalSignIn | null = signIn) => {
    if (!device.memoryUrl) {
      return;
    }

    setConnectingId(device.id);
    setSignInError(null);
    profileErrorBeforeConnect.current = userError;
    connectInFlight.current = true;
    connectRuns.current += 1;
    // Once the code is spent, a failure needs a new sign-in: this one can open nothing else.
    let spent = false;

    try {
      const origin = resolveHttpOrigin(device.memoryUrl);
      // Before the code is spent: an unreachable Memory leaves the sign-in for another pick.
      await probeMemoryOrigin(origin);

      let bearer: string | null | undefined;

      if (held) {
        if (!device.resource) {
          setSignInError('The Companion server did not return a sign-in for this Memory Server.');
          setConnectingId(null);

          return;
        }

        // The sign-in's code is spent on this Memory alone: the exchange names it, and the
        // id_token that comes back works here only, whoever runs the server it is sent to.
        let tokens: OidcTokens;

        try {
          tokens = await exchangePortalSignIn(held, {
            ...device,
            memoryUrl: device.memoryUrl,
            resource: device.resource,
          });
        } catch (err) {
          setConnectingId(null);

          if (err instanceof PortalSignInExpiredError) {
            signInAgain(err.message);

            return;
          }

          // From the Companion server, not this Memory, so in its own words. invalid_target
          // leaves the code unspent, and another Memory can still be picked.
          const text = err instanceof Error ? err.message : '';
          const unreachable =
            err instanceof Error &&
            (err.name === 'TimeoutError' || /load failed|failed to fetch|network/i.test(text));

          setSignInError(unreachable ? portalUnreachableMessage(held.portal) : text || 'Sign-in failed');

          return;
        }

        spent = true;
        setSignIn(null);
        bearer = bearerAddressedTo(tokens.idToken, device.resource);

        if (!bearer) {
          setConnectingId(null);
          signInAgain('The Companion server did not return a sign-in for this Memory Server.');

          return;
        }
      } else {
        // An older Portal: the id_token is all there is. Never the access token,
        // which is a credential for the Portal itself.
        if (auth?.kind !== 'oauth' || !auth.idToken) {
          setSignInError('Sign in with your Companion account first, then pick this server again.');
          setConnectingId(null);

          return;
        }

        [bearer] = selectMemoryPortalBearers([auth.idToken]);

        if (!bearer) {
          setSignInError('Your Companion sign-in expired. Sign in again.');
          setConnectingId(null);

          return;
        }
      }

      // Mint against the picked Memory origin. Apply it in memory first so
      // CapacitorHttp never sees a relative `/api/graphql`. Persist on success
      // only — a leftover origin with no key used to skip cloud-connect.
      await completePortalMemoryConnect(bearer, origin);
      persistApiBaseUrl(origin);
      setAwaitingProfile(true);
      void refetch();
    } catch (err) {
      const unauthorized = /unauthorized/i.test(err instanceof Error ? err.message : '');
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? 'Could not reach your Companion Memory (timed out).'
          : /load failed|failed to fetch/i.test(err instanceof Error ? err.message : '')
            ? 'Could not reach this Memory Server from the phone (webview blocked the request). Retry after the app reloads native HTTP.'
            : unauthorized
              ? 'This Memory Server is online, but it did not accept your Companion account. Sign in again.'
              : `Could not sign in to ${device.memoryUrl}. ${err instanceof Error ? err.message : ''}`.trim();

      setConnectingId(null);

      if (spent) {
        signInAgain(message);
      } else {
        setSignInError(message);
      }
    } finally {
      connectInFlight.current = false;
    }
  };

  useEffect(() => {
    if (!resumedPick) {
      return;
    }

    setResumedPick(null);
    void handleConnect(resumedPick.device, resumedPick.signIn);
    // handleConnect is rebuilt every render; this runs once per resumed pick.
  }, [resumedPick]);

  if (finishingSignIn) {
    return <LoadingPage message="Finishing sign-in…" />;
  }

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
          {accountEmail ? (
            <p className="text-muted-foreground mb-3 text-center text-sm" data-testid="portal-account">
              Signed in as {accountEmail}
            </p>
          ) : null}
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
                      // Not while a list is in flight: one that lands after the pick spent the code
                      // would answer invalid_grant, or hand the spent sign-in back.
                      <button
                        key={device.id}
                        type="button"
                        disabled={busy || connectingId !== null || !reachable}
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
                    onClick={() => {
                      clearStoredPortalAuth();
                      void forgetPortalSignIn();
                      setAuth(null);
                      setSignIn(null);
                      setDevices([]);
                      setStep('sign-in');
                    }}
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
                {/* Leaving mid-connect would leave a pairing running with no page to report it. */}
                <Button
                  type="button"
                  variant="ghost"
                  className={TOUCH}
                  onClick={() => navigate('/device-connect/advanced')}
                  disabled={connectingId !== null}
                  data-testid="picker-advanced-btn"
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
