import { useEffect, useRef, useSyncExternalStore } from 'react';

import { getApiKey, subscribeApiKey } from '@ci/common';

import { type LiveChangeTopic, setLiveChangesAuth, subscribeLiveChanges } from '@/api/liveChanges';

import { useSessionAuth } from './useSessionAuth';

/**
 * Run `onChange` whenever the server says something under `topics` changed —
 * typically a query's `refetch`. See `api/liveChanges.ts` for the stream.
 *
 * The callback is read through a ref, so a new function each render does not
 * resubscribe, and the subscription is keyed on the topic list's contents.
 */
export function useLiveChanges(topics: readonly LiveChangeTopic[], onChange: () => void): void {
  const { ready, authToken } = useSessionAuth();
  // The phone and desktop apps have no web token. They send a short-lived access token for the
  // device's key as `x-api-key`, which is renewed every few minutes. Subscribed, so each new one
  // (and a sign-in or sign-out) reaches the stream without waiting for a render.
  const currentKey = useSyncExternalStore(subscribeApiKey, getApiKey, getApiKey);
  const apiKey = ready && !authToken ? currentKey : null;
  const onChangeRef = useRef(onChange);
  const key = topics.join(',');

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (apiKey) {
      setLiveChangesAuth(apiKey, 'apiKey');
    } else {
      setLiveChangesAuth(ready ? authToken : null);
    }
  }, [ready, authToken, apiKey]);

  useEffect(() => {
    if (!key) {
      return undefined;
    }

    return subscribeLiveChanges(key.split(',') as LiveChangeTopic[], () => onChangeRef.current());
  }, [key]);
}
