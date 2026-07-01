import { type ReactNode } from 'react';

import { act, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AVAILABLE_ENTITY_TYPES, DropdownProvider, useDropdown } from './useDropdown';

function makeWrapper(changeSearchParams = true, initialEntries: string[] = ['/']) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={initialEntries}>
      <DropdownProvider args={[{ changeSearchParams }]}>{children}</DropdownProvider>
    </MemoryRouter>
  );
}

describe('useDropdown', () => {
  it('selects all entity types by default', () => {
    const { result } = renderHook(() => useDropdown(), { wrapper: makeWrapper() });

    expect(result.current[0].selectedEntityTypes).toEqual(AVAILABLE_ENTITY_TYPES);
  });

  it('toggling an entity type excludes then re-includes it', () => {
    const { result } = renderHook(() => useDropdown(), { wrapper: makeWrapper() });

    act(() => result.current[1].toggleEntityType('Person'));
    expect(result.current[0].selectedEntityTypes).not.toContain('Person');
    expect(result.current[0].selectedEntityTypes).toHaveLength(AVAILABLE_ENTITY_TYPES.length - 1);

    act(() => result.current[1].toggleEntityType('Person'));
    expect(result.current[0].selectedEntityTypes).toContain('Person');
  });

  it('hydrates the selection from excludedEntityTypes in the URL', () => {
    const { result } = renderHook(() => useDropdown(), {
      wrapper: makeWrapper(true, ['/?excludedEntityTypes=Person,Place']),
    });

    expect(result.current[0].selectedEntityTypes).not.toContain('Person');
    expect(result.current[0].selectedEntityTypes).not.toContain('Place');
    expect(result.current[0].selectedEntityTypes).toContain('Event');
  });

  it('hydrates the selection from includedEntityTypes in the URL', () => {
    const { result } = renderHook(() => useDropdown(), {
      wrapper: makeWrapper(true, ['/?includedEntityTypes=Person']),
    });

    expect(result.current[0].selectedEntityTypes).toEqual(['Person']);
  });

  it('clearEntityTypes resets to all selected', () => {
    const { result } = renderHook(() => useDropdown(), {
      wrapper: makeWrapper(true, ['/?excludedEntityTypes=Person']),
    });

    act(() => result.current[1].clearEntityTypes());
    expect(result.current[0].selectedEntityTypes).toEqual(AVAILABLE_ENTITY_TYPES);
  });

  it('round-trips tags, date range and sort through the URL', () => {
    const { result } = renderHook(() => useDropdown(), { wrapper: makeWrapper() });

    act(() => result.current[1].setTags(['travel', 'food']));
    expect(result.current[0].tags).toEqual(['travel', 'food']);

    act(() => result.current[1].setDateRange('2026-01-01', '2026-02-01'));
    expect(result.current[0].dateFrom).toBe('2026-01-01');
    expect(result.current[0].dateTo).toBe('2026-02-01');

    act(() => result.current[1].setSort('time', 'desc'));
    expect(result.current[0].sortBy).toBe('time');
    expect(result.current[0].sortOrder).toBe('desc');
  });

  it('is read-only when changeSearchParams is false', () => {
    const { result } = renderHook(() => useDropdown(), { wrapper: makeWrapper(false) });

    act(() => result.current[1].setTags(['ignored']));
    expect(result.current[0].tags).toEqual([]);
  });
});
