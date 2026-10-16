import { type ReactNode } from 'react';

import { act, renderHook } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { useSearchAreas } from './AreaLayer';

function wrapper(initialEntries: string[]) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
  );
}

describe('useSearchAreas', () => {
  it('writes the rectangles without touching Has a location, which is the person’s own switch', () => {
    const { result } = renderHook(() => ({ areas: useSearchAreas(), params: useSearchParams()[0] }), {
      wrapper: wrapper(['/memory?view=map&hasLocation=1']),
    });

    act(() => result.current.areas[1]([[165.5, -47.5, 179.5, -33.5]]));

    expect(result.current.params.get('areas')).toBe('165.500000,-47.500000,179.500000,-33.500000');
    expect(result.current.areas[0]).toEqual([[165.5, -47.5, 179.5, -33.5]]);
    expect(result.current.params.get('hasLocation')).toBe('1');

    act(() => result.current.areas[1]([]));

    expect(result.current.params.has('areas')).toBe(false);
    expect(result.current.params.get('hasLocation')).toBe('1');
  });

  it('does not select Has a location for a rectangle, since the server ORs it with the Where names', () => {
    const { result } = renderHook(() => ({ areas: useSearchAreas(), params: useSearchParams()[0] }), {
      wrapper: wrapper(['/memory?view=map']),
    });

    act(() => result.current.areas[1]([[165.5, -47.5, 179.5, -33.5]]));

    expect(result.current.params.get('areas')).toBe('165.500000,-47.500000,179.500000,-33.500000');
    expect(result.current.params.has('hasLocation')).toBe(false);
  });

  it('supersedes a legacy ?bbox with the list', () => {
    const { result } = renderHook(() => ({ areas: useSearchAreas(), params: useSearchParams()[0] }), {
      wrapper: wrapper(['/memory?bbox=1,2,3,4']),
    });

    expect(result.current.areas[0]).toEqual([[1, 2, 3, 4]]);

    act(() => result.current.areas[1]([[5, 6, 7, 8]]));

    expect(result.current.params.has('bbox')).toBe(false);
    expect(result.current.params.get('areas')).toBe('5.000000,6.000000,7.000000,8.000000');
  });
});
