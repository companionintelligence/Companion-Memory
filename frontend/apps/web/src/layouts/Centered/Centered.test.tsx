import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { Centered } from './Centered';

vi.mock('@/components/ThemePicker', () => ({ ThemeToggle: () => null }));

/**
 * The body is pinned (usePreventOverscroll), so the layout's own column is the
 * only thing on /login, /signup and /device-connect/advanced that can scroll.
 * With `min-h-dvh` it grew with the form instead, and a form taller than a
 * short window (sign-up at 125% text size) lost its last buttons below the edge.
 */
describe('Centered', () => {
  it('holds its column to the visible height so a taller form scrolls inside it', () => {
    render(
      <MemoryRouter initialEntries={['/signup']}>
        <Routes>
          <Route element={<Centered />}>
            <Route path="/signup" element={<p>form</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const column = screen.getByText('form').closest('.overflow-y-auto');

    expect(column).toHaveClass('h-[var(--vv-height,100dvh)]', 'overflow-y-auto');
    expect(column).not.toHaveClass('min-h-dvh');
  });
});
