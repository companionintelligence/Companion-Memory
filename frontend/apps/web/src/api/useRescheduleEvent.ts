import { useCallback } from 'react';

import { gql } from '@apollo/client';
import { useMutation } from '@apollo/client/react';

const RESCHEDULE_EVENT = gql(`
  mutation RescheduleEvent($id: ID!, $startTime: DateTime!, $endTime: DateTime) {
    rescheduleEvent(id: $id, startTime: $startTime, endTime: $endTime) {
      id
      title
      startTime
      endTime
      externalSyncStatus
    }
  }
`);

/**
 * Move a committed event.
 *
 * The end time is left to the server so duration is preserved from whatever the
 * row actually holds, rather than from what the client happens to have cached.
 *
 * REJECTS when the server refuses the move, and `onMoved` runs only on success.
 * The caller owns the failure: a move is a fire-and-forget gesture, so nothing
 * else will notice — the chip just snaps back.
 */
export function useRescheduleEvent(onMoved?: () => void) {
  const [rescheduleEvent] = useMutation(RESCHEDULE_EVENT);

  return useCallback(
    async (id: string, startTime: Date) => {
      await rescheduleEvent({ variables: { id, startTime: startTime.toISOString(), endTime: null } });
      onMoved?.();
    },
    [rescheduleEvent, onMoved],
  );
}
