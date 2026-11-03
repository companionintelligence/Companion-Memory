import { useEffect, useState } from 'react';

import { fetchJson, GlobalUID, isNativePlatform, LoadingPage } from '@ci/common';
import { Navigate, useLocation } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { isPastOutage, MemoryUnreachable } from '@/components/MemoryUnreachable';
import { useAuth, useCurrentUser } from '@/hooks';
import { appHomePath } from '@/lib/appHome';

function emailsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
}

/**
 * The account's own id from `user.id`, which GraphQL hands out as a global id (base64 of
 * `user:<uuid>`), while the Hub identity names the account by the bare uuid.
 */
function accountIdOf(userId: string): string {
  try {
    return GlobalUID.decode(userId).id;
  } catch {
    return userId;
  }
}

/** Why the session bridge would not sign the Hub person in (the server's `HubBridgeRefusal`). */
export type HubRefusal =
  'account_unavailable' | 'account_linked_elsewhere' | 'account_ambiguous' | 'account_unproven';

/** What `GET /api/authenticate/hub-identity` says about the Hub person behind this request. */
export interface HubIdentity {
  username: string | null;
  /** The Memory account the Hub person signs in as, when the Hub sends a stable id. */
  accountId: string | null;
  /** Why Memory would not sign the Hub person in at all, when it would not. */
  refused?: HubRefusal | null;
}

/**
 * Whether Traefik named a Hub person other than the signed-in `user`.
 *
 * By account when the server could say which one the Hub person signs in as. Their address
 * may have changed on the Hub or here since they were linked, and proves nothing either way.
 * By address otherwise, which is all a Hub without stable ids gives to go on. A person Memory
 * refuses is not signed in to any account here, so any session this browser holds is someone
 * else's, even one at their address. (For `account_unproven` the account at the address may be
 * theirs; signing in to it with its password, then reloading, links them.)
 */
export function hubNamesSomeoneElse(user: { id: string; email: string }, hub: HubIdentity): boolean {
  if (!hub.username) {
    return false;
  }

  if (hub.refused) {
    return true;
  }

  if (hub.accountId) {
    return hub.accountId !== accountIdOf(user.id);
  }

  return !emailsEqual(user.email, hub.username);
}

const NO_HUB_IDENTITY: HubIdentity = { username: null, accountId: null, refused: null };

export function RedirectKnownUser({ children }: { children: React.ReactNode }) {
  // `initializing`, not `loading`: the latter is also true while a login or
  // signup POST is in flight, and swapping in LoadingPage then unmounts the
  // very form awaiting the response — wiping the user's input and the local
  // state needed to attach the server's field errors.
  const [{ expired, authToken, authenticated, initializing, unreachable: sessionUnreachable }] = useAuth();
  const { user, loading: userLoading, unreachable: profileUnreachable, refetch } = useCurrentUser();
  const { loading: featuresLoading } = useFeatures();
  const location = useLocation();
  const [hubIdentity, setHubIdentity] = useState<HubIdentity | undefined>(undefined);

  useEffect(() => {
    if (isNativePlatform()) {
      setHubIdentity(NO_HUB_IDENTITY);

      return;
    }

    let cancelled = false;

    void fetchJson<Partial<HubIdentity>>('/api/authenticate/hub-identity', {
      credentials: 'include',
    })
      .then((body) => {
        if (!cancelled) {
          setHubIdentity({
            username: body?.username ?? null,
            accountId: body?.accountId ?? null,
            refused: body?.refused ?? null,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHubIdentity(NO_HUB_IDENTITY);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Memory did not answer the session check or the profile and there is no profile to go on.
  // The splash, Log In and Sign up cannot work then, so say so, as the pages inside the app do
  // (ProtectedRoute). The card's link comes back here with `pastOutage` and gets the form
  // anyway. A known user still goes on to their memory below. A phone goes on to its device
  // picker, where it can choose an appliance that answers.
  if ((sessionUnreachable || profileUnreachable) && !user && !isNativePlatform()) {
    if (isPastOutage(location.state)) {
      return children;
    }

    return (
      <MemoryUnreachable
        signedIn={Boolean(authToken || authenticated)}
        onRetry={() => {
          if (sessionUnreachable) {
            // Not refresh(): with no session it answers 401, which Log In shows as an error.
            window.location.reload();
          } else {
            void refetch?.();
          }
        }}
      />
    );
  }

  if (initializing || userLoading || hubIdentity === undefined || (user?.onboarded && featuresLoading)) {
    return <LoadingPage />;
  }

  if (expired && !authenticated) {
    return children;
  }

  // A valid token with no resolved user means the profile query failed or the
  // account no longer exists — do not spin forever (see ProtectedRoute).
  if ((authToken || authenticated) && !user) {
    return <Navigate to={isNativePlatform() ? '/device-connect' : '/login'} replace />;
  }

  // Traefik already named a different Hub person. Do not send them to the
  // previous Memory home / onboarding — wait for the session bridge to replace
  // the cookie, or fall through to the login children if it cannot.
  if (user && hubNamesSomeoneElse(user, hubIdentity)) {
    return children;
  }

  if (user) {
    if (user.onboarded) {
      return <Navigate to={appHomePath()} />;
    }

    return <Navigate to="/onboarding" />;
  }

  return children;
}
