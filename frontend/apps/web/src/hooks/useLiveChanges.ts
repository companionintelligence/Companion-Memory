import { useEffect, useRef } from 'react';

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
  const onChangeRef = useRef(onChange);
  const key = topics.join(',');

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    setLiveChangesAuth(ready ? authToken : null);
  }, [ready, authToken]);

  useEffect(() => {
    if (!key) {
      return undefined;
    }

    return subscribeLiveChanges(key.split(',') as LiveChangeTopic[], () => onChangeRef.current());
  }, [key]);
}
