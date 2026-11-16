import { useEffect, useRef } from 'react';

import { getApiKey } from '@ci/common';

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
  // The phone app has no web token. It signs in with the device's API key,
  // which the stream sends as `x-api-key`. Read on every render, so a new key
  // (signing in again) reaches the stream.
  const apiKey = ready && !authToken ? getApiKey() : null;
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
