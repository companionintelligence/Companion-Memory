import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useOnboardingProgress } from './useOnboardingProgress';

const h = vi.hoisted(() => ({ authToken: 'jwt-abc' as string | null }));

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: h.authToken }],
}));

const fetchJson = vi.hoisted(() => vi.fn());

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson,
}));

beforeEach(() => {
  h.authToken = 'jwt-abc';
  fetchJson.mockReset();
});

describe('useOnboardingProgress — fetchProgress', () => {
  it('requests the saved progress with a bearer token and returns it', async () => {
    const progress = {
      stepKey: 'trust-dial' as const,
      draft: { trust_mode: 'balanced' },
      updatedAt: '2026-01-01T00:00:00Z',
    };
    fetchJson.mockResolvedValue(progress);

    const { result } = renderHook(() => useOnboardingProgress());

    let returned: unknown;
    await act(async () => {
      returned = await result.current.fetchProgress();
    });

    expect(fetchJson).toHaveBeenCalledWith('/api/onboarding/progress', {
      headers: { Authorization: 'Bearer jwt-abc' },
    });
    expect(returned).toEqual(progress);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('treats a null response as "no saved progress", not an error', async () => {
    fetchJson.mockResolvedValue(null);

    const { result } = renderHook(() => useOnboardingProgress());

    let returned: unknown;
    await act(async () => {
      returned = await result.current.fetchProgress();
    });

    expect(returned).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('skips the request and resolves null when there is no session yet', async () => {
    h.authToken = null;

    const { result } = renderHook(() => useOnboardingProgress());

    let returned: unknown;
    await act(async () => {
      returned = await result.current.fetchProgress();
    });

    expect(fetchJson).not.toHaveBeenCalled();
    expect(returned).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('captures a request failure in `error` and still resolves null rather than throwing', async () => {
    const failure = new Error('network down');
    fetchJson.mockRejectedValue(failure);

    const { result } = renderHook(() => useOnboardingProgress());

    let returned: unknown;
    await act(async () => {
      returned = await result.current.fetchProgress();
    });

    expect(returned).toBeNull();
    expect(result.current.error).toBe(failure);
    expect(result.current.loading).toBe(false);
  });

  it('clears a stale error on the next successful fetch', async () => {
    fetchJson.mockRejectedValueOnce(new Error('first attempt failed'));

    const { result } = renderHook(() => useOnboardingProgress());

    await act(async () => {
      await result.current.fetchProgress();
    });
    expect(result.current.error).not.toBeNull();

    fetchJson.mockResolvedValueOnce({ stepKey: 'trust-dial', draft: {}, updatedAt: null });

    await act(async () => {
      await result.current.fetchProgress();
    });
    expect(result.current.error).toBeNull();
  });
});

describe('useOnboardingProgress — saveProgress', () => {
  it('PUTs the step key and draft as JSON with a bearer token', async () => {
    fetchJson.mockResolvedValue({});

    const { result } = renderHook(() => useOnboardingProgress());

    await act(async () => {
      await result.current.saveProgress('trust-dial', { trust_mode: 'balanced' });
    });

    expect(fetchJson).toHaveBeenCalledWith('/api/onboarding/progress', {
      method: 'PUT',
      headers: { Authorization: 'Bearer jwt-abc', 'Content-Type': 'application/json' },
      body: JSON.stringify({ stepKey: 'trust-dial', draft: { trust_mode: 'balanced' } }),
    });
  });

  it('does nothing without a session — no request, no throw', async () => {
    h.authToken = null;

    const { result } = renderHook(() => useOnboardingProgress());

    await act(async () => {
      await result.current.saveProgress('trust-dial', { trust_mode: 'balanced' });
    });

    expect(fetchJson).not.toHaveBeenCalled();
  });
});
