import { gql } from '@apollo/client';
import { useMutation } from '@apollo/client/react';

const TRIGGER_HBPE = gql(`
  mutation TriggerHbpe {
    triggerHbpe
  }
`);

export function useTriggerHbpe() {
  const [mutate, { loading, error, data }] = useMutation<{ triggerHbpe: string }>(TRIGGER_HBPE);

  const trigger = async () => {
    const response = await mutate();

    return response.data?.triggerHbpe ?? 'error';
  };

  return [{ loading, error, status: data?.triggerHbpe }, { trigger }] as const;
}
