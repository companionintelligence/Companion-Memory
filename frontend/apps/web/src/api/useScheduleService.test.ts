import { useQuery } from '@apollo/client';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLiveChanges } from '@/hooks/useLiveChanges';
import { useRefetchOnReturn } from '@/hooks/useRefetchOnReturn';

import { type RhythmDay, useScheduleService } from './useScheduleService';

// Mock Apollo's useQuery rather than standing up MockedProvider: everything
// under test here is what the hook does to the response and what options it
// asks for, both of which the network layer would only obscure.
vi.mock('@apollo/client', async (orig) => ({
  ...(await orig<typeof import('@apollo/client')>()),
  useQuery: vi.fn(),
}));

vi.mock('@/hooks/useLiveChanges', () => ({ useLiveChanges: vi.fn() }));
vi.mock('@/hooks/useRefetchOnReturn', () => ({ useRefetchOnReturn: vi.fn() }));

const mockedUseQuery = vi.mocked(useQuery);
const mockedUseLiveChanges = vi.mocked(useLiveChanges);
const mockedUseRefetchOnReturn = vi.mocked(useRefetchOnReturn);

const GENERATED_AT = '2026-08-05T03:00:00.000Z';

const refetch = vi.fn();

interface QueryShape {
  eventsInRange?: unknown[] | null;
  weekForecast?: { generatedAt: string; days: RhythmDay[] } | null;
}

function setResult(data: QueryShape | undefined, error?: Error) {
  mockedUseQuery.mockReturnValue({
    data,
    loading: false,
    error,
    refetch,
  } as unknown as ReturnType<typeof useQuery>);
}

function lastOptions() {
  return mockedUseQuery.mock.calls.at(-1)?.[1] as {
    errorPolicy?: string;
    variables: Record<string, string>;
    pollInterval?: number;
    skipPollAttempt?: () => boolean;
  };
}

/** The UTC date key HorizonGrid looks the rhythm lane up by. */
function utcKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);

  return d;
}

function startOfLocalDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);

  return d;
}

function rhythmDay(date: string): RhythmDay {
  return { date, dow: 'Mon', clusters: [] };
}

/** The week the page opens on: today through today + 7. */
function currentWindow() {
  const start = startOfLocalDay(new Date());

  return { start, end: addDays(start, 7) };
}

/**
 * A date key that is inside the window whatever the local timezone is.
 *
 * Anchoring on the window's midpoint rather than on either edge keeps these
 * cases from depending on which UTC date a local midnight resolves to — the
 * exact ambiguity the filter exists to handle.
 */
function keyInside({ start, end }: { start: Date; end: Date }): string {
  return utcKey(new Date((start.getTime() + end.getTime()) / 2));
}

beforeEach(() => setResult(undefined));
afterEach(() => mockedUseQuery.mockReset());

describe('useScheduleService — the rhythm layer and the window it is drawn in', () => {
  it('keeps only the forecast days the drawn window can actually use', () => {
    // `weekForecast` takes no date arguments, so it answers with "the seven days
    // from today" no matter which week was asked for. Anything outside would be
    // keyed to dates the grid never draws and would miss every lookup.
    const window = currentWindow();
    const inside = keyInside(window);
    const before = utcKey(addDays(window.start, -30));
    const after = utcKey(addDays(window.end, 30));

    setResult({
      eventsInRange: [],
      weekForecast: {
        generatedAt: GENERATED_AT,
        days: [rhythmDay(before), rhythmDay(inside), rhythmDay(after)],
      },
    });

    const { result } = renderHook(() => useScheduleService(window.start, window.end));

    expect(result.current.rhythm.map((day) => day.date)).toEqual([inside]);
  });

  it('reports coverage for the window that holds today', () => {
    const window = currentWindow();

    setResult({
      eventsInRange: [],
      weekForecast: { generatedAt: GENERATED_AT, days: [rhythmDay(keyInside(window))] },
    });

    const { result } = renderHook(() => useScheduleService(window.start, window.end));

    expect(result.current.rhythmCoversWindow).toBe(true);
    expect(result.current.generatedAt).toBe(GENERATED_AT);
  });

  it('refuses to claim coverage of next week, which the forecast cannot reach', () => {
    // The regression: the forecast resolved fine, just for the wrong days, so
    // `generatedAt` was non-null and the footer went on announcing a live layer
    // over a lane with nothing in it.
    const start = addDays(startOfLocalDay(new Date()), 7);
    const end = addDays(start, 7);
    const today = utcKey(startOfLocalDay(new Date()));

    setResult({
      eventsInRange: [],
      weekForecast: { generatedAt: GENERATED_AT, days: [rhythmDay(today)] },
    });

    const { result } = renderHook(() => useScheduleService(start, end));

    expect(result.current.rhythm).toEqual([]);
    expect(result.current.rhythmCoversWindow).toBe(false);
  });

  it('refuses to claim coverage of a week already gone', () => {
    const end = startOfLocalDay(new Date());
    const start = addDays(end, -7);

    setResult({
      eventsInRange: [],
      weekForecast: { generatedAt: GENERATED_AT, days: [rhythmDay(keyInside({ start, end }))] },
    });

    const { result } = renderHook(() => useScheduleService(start, end));

    expect(result.current.rhythmCoversWindow).toBe(false);
  });

  it('has no coverage at all when the forecast resolver returned null', () => {
    const window = currentWindow();
    setResult({ eventsInRange: [], weekForecast: null });

    const { result } = renderHook(() => useScheduleService(window.start, window.end));

    expect(result.current.rhythm).toEqual([]);
    expect(result.current.generatedAt).toBeNull();
    expect(result.current.rhythmCoversWindow).toBe(false);
  });
});

describe('useScheduleService — failure', () => {
  it('asks for an errorPolicy that lets one failed field through', () => {
    const window = currentWindow();
    renderHook(() => useScheduleService(window.start, window.end));

    expect(lastOptions().errorPolicy).toBe('all');
  });

  it('keeps the events that resolved when the forecast errored', () => {
    // The default 'none' throws the whole payload away, so a cold HBPE sidecar
    // used to blank committed time as well.
    const window = currentWindow();

    setResult({ eventsInRange: [{ id: 'e1' }], weekForecast: null }, new Error('forecast unavailable'));

    const { result } = renderHook(() => useScheduleService(window.start, window.end));

    expect(result.current.events).toHaveLength(1);
    expect(result.current.error).toBe(true);
    expect(result.current.rhythm).toEqual([]);
  });

  it('reports an error with no data at all', () => {
    const window = currentWindow();
    setResult(undefined, new Error('network down'));

    const { result } = renderHook(() => useScheduleService(window.start, window.end));

    expect(result.current.error).toBe(true);
    expect(result.current.events).toEqual([]);
  });
});

describe('useScheduleService — refetch identity', () => {
  it('hands back the same refetch across renders', () => {
    // It is passed as `onPlaced` / `onMoved` into hooks that list it in
    // useCallback deps, so a fresh arrow each render churns every handler below.
    const window = currentWindow();
    setResult({ eventsInRange: [], weekForecast: null });

    const { result, rerender } = renderHook(() => useScheduleService(window.start, window.end));
    const first = result.current.refetch;

    rerender();

    expect(result.current.refetch).toBe(first);
  });
});

describe('useScheduleService — staying current', () => {
  it('polls every half minute as the fallback, skipping the poll while the tab is hidden', () => {
    setResult({ eventsInRange: [] });
    renderHook(() => useScheduleService(new Date('2026-08-03T00:00:00Z'), new Date('2026-08-10T00:00:00Z')));

    const options = lastOptions();
    expect(options.pollInterval).toBe(30_000);

    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    expect(options.skipPollAttempt?.()).toBe(true);
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    expect(options.skipPollAttempt?.()).toBe(false);
  });

  it('refetches on a calendar change from the server and on return to the tab', () => {
    setResult({ eventsInRange: [] });
    renderHook(() => useScheduleService(new Date('2026-08-03T00:00:00Z'), new Date('2026-08-10T00:00:00Z')));

    expect(mockedUseLiveChanges).toHaveBeenCalledWith(['calendar'], expect.any(Function));
    const [, onChange] = mockedUseLiveChanges.mock.calls.at(-1)!;
    const [onReturn] = mockedUseRefetchOnReturn.mock.calls.at(-1)!;
    refetch.mockClear();

    onChange();
    onReturn();

    expect(refetch).toHaveBeenCalledTimes(2);
  });
});
