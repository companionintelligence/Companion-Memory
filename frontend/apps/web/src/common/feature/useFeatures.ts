import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  createHookContext,
  fetchJson,
  getApiBaseUrl,
  isNativePlatform,
  subscribeApiBaseUrl,
} from '@ci/common';

import { useAuth } from '@/hooks';

import {
  recallFeatures,
  recallGlobalFeatures,
  rememberFeatures,
  rememberGlobalFeatures,
} from './rememberedFeatures';

type Features = Record<string, boolean>;

/** The remembered-flags subject for an API-key session, which has no JWT subject of its own. */
const API_KEY_SUBJECT = 'api-key';

type ReturnValue = {
  isFeatureEnabled: (featureName: string) => boolean;
  /**
   * True until both flag sets have been answered for. `isFeatureEnabled` reports
   * *every* flag as disabled before then, which is indistinguishable from a flag
   * that really is off — so anything that would take an irreversible-looking
   * action on "disabled" (rendering a 404, redirecting away) has to wait this out.
   */
  loading: boolean;
  refresh: () => Promise<void>;
};

function useFeatures(): ReturnValue {
  const [{ authToken, authenticated, initializing, subject }] = useAuth();
  const origin = useSyncExternalStore(subscribeApiBaseUrl, getApiBaseUrl, getApiBaseUrl);
  const nativeOriginReady = !isNativePlatform() || Boolean(origin);

  const [features, setFeatures] = useState<Features>({});
  const [globalFeatures, setGlobalFeatures] = useState<Features>({});

  const hasFetched = useRef(false);
  const hasFetchedGlobal = useRef(false);
  // Whether each map holds an answer worth consulting: fetched this session, or the set
  // remembered from the last successful fetch when this one failed (rememberedFeatures.ts).
  // Kept apart from `hasFetched`, which also decides whether a later call fetches again:
  // a remembered set must not stop the next real fetch.
  const userKnown = useRef(false);
  const globalKnown = useRef(false);

  // Refs cannot drive a re-render, so `loading` needs its own state. "Settled"
  // means answered, not answered successfully: a failed fetch leaves the flags
  // off, and callers should act on that rather than spin forever.
  const [userSettled, setUserSettled] = useState(false);
  const [globalSettled, setGlobalSettled] = useState(false);

  // Mirrors `subject` for the async fetch below to read back. The fetch closure
  // captures the subject of the render that created it, which may be a session
  // ago by the time the response lands.
  const liveSubject = useRef(subject);
  const liveOrigin = useRef(origin);
  // Who the remembered flags belong to. A desktop session has a JWT subject. The phone's
  // session is an API key with no token to decode, so its subject is null — and the key
  // identifies the one person paired to this phone, so a fixed marker stands for them.
  const rememberedAs = subject ?? (authenticated && !authToken ? API_KEY_SUBJECT : null);

  const fetchFeatures = useCallback(
    async (force = false) => {
      // Desktop sends its session token. The phone has no session token; it is
      // signed in with an API key, which fetchJson attaches as x-api-key.
      if (!authenticated) {
        return;
      }

      if (!nativeOriginReady) {
        return;
      }

      if (hasFetched.current && !force) {
        return;
      }

      const forSubject = subject;
      const forOrigin = origin;
      const forRemembered = rememberedAs;

      try {
        const data = await fetchJson<Features>(
          '/api/_internal/features',
          authToken
            ? {
                headers: {
                  Authorization: `Bearer ${authToken}`,
                },
              }
            : undefined,
        );

        // The session can end, or the phone can pair a different box, while
        // this is in flight. The reset effect has already cleared the cache
        // by then. A late response must not land on top of that.
        if (liveSubject.current !== forSubject || liveOrigin.current !== forOrigin) {
          return;
        }

        if (data) {
          setFeatures(data);
          hasFetched.current = true;
          userKnown.current = true;

          if (forRemembered) {
            rememberFeatures(forOrigin, forRemembered, data);
          }
        }
      } catch (err) {
        console.error('Failed to fetch features', err);

        // The appliance did not answer: the flags it last gave this person at this box
        // still describe their account, and the routes behind them must not vanish.
        const remembered = recallFeatures(forOrigin, forRemembered);

        if (remembered && liveSubject.current === forSubject && liveOrigin.current === forOrigin) {
          setFeatures(remembered);
          userKnown.current = true;
        }
      } finally {
        // Same reasoning: settling here would report the *new* session's flags
        // as known on the strength of a fetch made for the previous one.
        if (liveSubject.current === forSubject && liveOrigin.current === forOrigin) {
          setUserSettled(true);
        }
      }
    },
    [authToken, authenticated, nativeOriginReady, origin, rememberedAs, subject],
  );

  const fetchGlobalFeatures = useCallback(
    async (force = false) => {
      if (!nativeOriginReady) {
        return;
      }

      if (hasFetchedGlobal.current && !force) {
        return;
      }

      const forOrigin = origin;

      try {
        const data = await fetchJson<Features>('/api/_internal/features/global');

        if (data) {
          setGlobalFeatures(data);
          hasFetchedGlobal.current = true;
          globalKnown.current = true;
          rememberGlobalFeatures(forOrigin, data);
        }
      } catch (err) {
        console.error('Failed to fetch features', err);

        const remembered = recallGlobalFeatures(forOrigin);

        if (remembered && liveOrigin.current === forOrigin) {
          setGlobalFeatures(remembered);
          globalKnown.current = true;
        }
      } finally {
        setGlobalSettled(true);
      }
    },
    [nativeOriginReady, origin],
  );

  // Per-user flags belong to the session that fetched them, and this provider
  // outlives any one session — it sits above the router, so logging out and back
  // in as someone else never unmounts it. Without this the `hasFetched` guard
  // below would skip the refetch and answer the second user with the first one's
  // flags, and `loading` would report false over them.
  //
  // Keyed on the subject rather than the token: useAutoRefreshToken rotates the
  // JWT every few minutes for the *same* user, and treating that as a new
  // identity would drop the flags, take the gated routes back out of the table,
  // and flash the very 404-then-page transition this hook exists to prevent.
  //
  // Declared ahead of the fetch effect so a changed identity is cleared before
  // the fetch that replaces it runs. On mount it is a no-op: the values it
  // assigns are the ones already there.
  useEffect(() => {
    liveSubject.current = subject;
    liveOrigin.current = origin;
    hasFetched.current = false;
    userKnown.current = false;
    setFeatures({});
    setUserSettled(false);
  }, [authenticated, origin, subject]);

  useEffect(() => {
    fetchFeatures();
  }, [fetchFeatures]);

  useEffect(() => {
    fetchGlobalFeatures();
  }, [fetchGlobalFeatures]);

  const isFeatureEnabled = useCallback(
    (featureName: string) => {
      if (userKnown.current && features[featureName] === true) {
        return true;
      }

      if (globalKnown.current && globalFeatures[featureName] === true) {
        return true;
      }

      return false;
    },
    [features, globalFeatures],
  );

  // The full map needs a signed-in principal (session token or API key), so
  // "signed out" is only an answer once the handshake has finished. The global
  // set is unauthenticated and always fetched.
  const userPending = initializing || (authenticated && !userSettled);

  return {
    isFeatureEnabled,
    loading: userPending || !globalSettled,
    refresh: async () => {
      await Promise.allSettled([fetchFeatures(true), fetchGlobalFeatures(true)]);
    },
  };
}

const { Provider, useHookContext, useOptionalHookContext } = createHookContext(useFeatures);

export {
  Provider as FeaturesProvider,
  useHookContext as useFeatures,
  // For leaf components that must render outside the app shell (tests, the
  // shared viewer): yields `undefined` where `useFeatures` would throw.
  useOptionalHookContext as useOptionalFeatures,
};
