import { useMutation } from '@apollo/client/react';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRescheduleEvent } from './useRescheduleEvent';

vi.mock('@apollo/client/react', async (orig) => ({
  ...(await orig<typeof import('@apollo/client/react')>()),
  useMutation: vi.fn(),
}));

const mockedUseMutation = vi.mocked(useMutation);
const mutate = vi.fn();

beforeEach(() => {
  mutate.mockResolvedValue({ data: {} });
  mockedUseMutation.mockReturnValue([mutate, {}] as unknown as ReturnType<typeof useMutation>);
});

afterEach(() => mockedUseMutation.mockReset());

describe('useRescheduleEvent', () => {
  it('sends the new start and leaves the end to the server', async () => {
    const onMoved = vi.fn();
    const { result } = renderHook(() => useRescheduleEvent(onMoved));

    await result.current('e1', new Date('2026-08-04T14:00:00.000Z'));

    expect(mutate).toHaveBeenCalledWith({
      variables: { id: 'e1', startTime: '2026-08-04T14:00:00.000Z', endTime: null },
    });
    expect(onMoved).toHaveBeenCalledTimes(1);
  });

  it('rejects a refused move rather than resolving, and does not re-read', async () => {
    // The caller has to see this: a move is a fire-and-forget gesture, so a
    // swallowed rejection leaves the chip snapping back with no explanation.
    mutate.mockRejectedValue(new Error('calendar is read-only'));
    const onMoved = vi.fn();

    const { result } = renderHook(() => useRescheduleEvent(onMoved));

    await expect(result.current('e1', new Date())).rejects.toThrow('calendar is read-only');
    expect(onMoved).not.toHaveBeenCalled();
  });
});
