import type { ReactNode } from 'react';

import { Form, useForm } from '@ci/shadcn';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useOnboardService } from './useOnboardService';

const h = vi.hoisted(() => ({
  authToken: 'jwt-abc' as string | null,
  refetch: vi.fn(async () => ({})),
}));

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: h.authToken }],
  useCurrentUser: () => ({ refetch: h.refetch }),
}));

const fetchJson = vi.hoisted(() => vi.fn());

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson,
}));

/** Mirrors how `OnboardingPage` actually wires the form: `useForm()` at the top,
 *  its methods spread onto `<Form>` (react-hook-form's `FormProvider`), which is
 *  what `useOnboardService`'s `useFormContext()` call reads from. */
function wrapper({ children }: { children: ReactNode }) {
  const form = useForm({ defaultValues: { name: 'J Smith', trust_mode: 'balanced' } });

  return <Form {...form}>{children}</Form>;
}

beforeEach(() => {
  h.authToken = 'jwt-abc';
  h.refetch.mockClear();
  fetchJson.mockReset();
});

describe('useOnboardService', () => {
  it('POSTs the current form values with a bearer token and refetches the current user on success', async () => {
    fetchJson.mockResolvedValue({ onboarded: true });

    const { result } = renderHook(() => useOnboardService(), { wrapper });

    await act(async () => {
      await result.current[1].onboard();
    });

    expect(fetchJson).toHaveBeenCalledWith('/api/onboarding/onboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer jwt-abc' },
      body: JSON.stringify({ name: 'J Smith', trust_mode: 'balanced' }),
    });
    expect(h.refetch).toHaveBeenCalledTimes(1);
    expect(result.current[0].loading).toBe(false);
    expect(result.current[0].error).toBeNull();
  });

  it('is loading synchronously once onboard is called, and settles once it resolves', async () => {
    // `onboard`'s public type is `() => void` — real callers (Submit.tsx) fire it
    // from a useEffect without awaiting — so this drives it the same fire-and-forget
    // way rather than capturing its (implementation-detail) returned promise.
    fetchJson.mockResolvedValue({ onboarded: true });

    const { result } = renderHook(() => useOnboardService(), { wrapper });

    act(() => {
      result.current[1].onboard();
    });

    expect(result.current[0].loading).toBe(true);

    await waitFor(() => expect(result.current[0].loading).toBe(false));
  });

  it('captures the failure and refetches nothing, rather than silently reporting success', async () => {
    const failure = new Error('server exploded');
    fetchJson.mockRejectedValue(failure);

    const { result } = renderHook(() => useOnboardService(), { wrapper });

    await act(async () => {
      await result.current[1].onboard();
    });

    expect(result.current[0].error).toBe(failure);
    expect(result.current[0].loading).toBe(false);
    expect(h.refetch).not.toHaveBeenCalled();
  });

  it('clears a stale error once a later call succeeds', async () => {
    fetchJson.mockRejectedValueOnce(new Error('first attempt failed'));

    const { result } = renderHook(() => useOnboardService(), { wrapper });

    await act(async () => {
      await result.current[1].onboard();
    });
    expect(result.current[0].error).not.toBeNull();

    fetchJson.mockResolvedValueOnce({ onboarded: true });

    await act(async () => {
      await result.current[1].onboard();
    });
    expect(result.current[0].error).toBeNull();
  });
});
