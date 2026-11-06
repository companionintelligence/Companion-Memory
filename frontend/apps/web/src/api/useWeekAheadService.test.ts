import { useQuery } from '@apollo/client/react';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWeekAheadService } from './useWeekAheadService';

vi.mock('@apollo/client/react', async (orig) => ({
  ...(await orig<typeof import('@apollo/client/react')>()),
  useQuery: vi.fn(),
}));

const mockedUseQuery = vi.mocked(useQuery);

function setResult(over: Record<string, unknown>) {
  mockedUseQuery.mockReturnValue({
    data: undefined,
    previousData: undefined,
    loading: false,
    error: undefined,
    ...over,
  } as unknown as ReturnType<typeof useQuery>);
}

function lastOptions() {
  return mockedUseQuery.mock.calls.at(-1)?.[1] as { errorPolicy?: string; pollInterval?: number };
}

const WEEK = { horizon: '7d', generatedAt: '2026-08-05T03:00:00.000Z', days: [] };

beforeEach(() => setResult({}));
afterEach(() => mockedUseQuery.mockReset());

describe('useWeekAheadService', () => {
  it('asks for an errorPolicy that lets one failed field through', () => {
    // The card carries two independent forecasts; one failing must not blank
    // the other. This is the pattern useScheduleService now follows too.
    renderHook(() => useWeekAheadService());

    expect(lastOptions().errorPolicy).toBe('all');
  });

  it('falls back to the last good response so a poll error does not unmount the card', () => {
    setResult({
      data: undefined,
      previousData: { weekForecast: WEEK, dueForecast: null },
      error: new Error('sidecar timeout'),
    });

    const { result } = renderHook(() => useWeekAheadService());

    expect(result.current.week).toEqual(WEEK);
    expect(result.current.error).toBeTruthy();
  });

  it('reports nulls rather than throwing when the forecasts are simply absent', () => {
    setResult({ data: { weekForecast: null, dueForecast: null } });

    const { result } = renderHook(() => useWeekAheadService());

    expect(result.current.week).toBeNull();
    expect(result.current.due).toBeNull();
  });
});
