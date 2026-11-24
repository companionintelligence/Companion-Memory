import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MENU_SHIELD_LINGER_MS, MenuShield } from './MenuShield';

describe('MenuShield', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is absent while the menu is closed and present while it is open', () => {
    const { rerender } = render(<MenuShield open={false} />);

    expect(screen.queryByTestId('menu-shield')).not.toBeInTheDocument();

    rerender(<MenuShield open />);

    expect(screen.getByTestId('menu-shield')).toHaveClass(
      'fixed',
      'inset-0',
      'pointer-events-auto',
      'max-device:block',
    );
  });

  // A Popover closes on the press; the same tap's click comes a moment later
  // and must still land on the sheet, not on what is under the finger.
  it('stays after the menu closes until the next click, which it catches', () => {
    const { rerender } = render(<MenuShield open />);

    rerender(<MenuShield open={false} />);

    const shield = screen.getByTestId('menu-shield');

    expect(shield).toBeInTheDocument();

    fireEvent.click(shield);

    expect(screen.queryByTestId('menu-shield')).not.toBeInTheDocument();
  });

  it('gives up lingering on its own when no click follows', () => {
    const { rerender } = render(<MenuShield open />);

    rerender(<MenuShield open={false} />);

    expect(screen.getByTestId('menu-shield')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(MENU_SHIELD_LINGER_MS);
    });

    expect(screen.queryByTestId('menu-shield')).not.toBeInTheDocument();
  });

  it('comes straight back if the menu reopens while it is lingering', () => {
    const { rerender } = render(<MenuShield open />);

    rerender(<MenuShield open={false} />);
    rerender(<MenuShield open />);

    act(() => {
      vi.advanceTimersByTime(MENU_SHIELD_LINGER_MS * 2);
    });

    expect(screen.getByTestId('menu-shield')).toBeInTheDocument();
  });
});
