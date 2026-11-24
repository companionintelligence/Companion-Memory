import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSwipeToDismiss } from './useSwipeToDismiss';

function Harness({ enabled = true, onDismiss }: { enabled?: boolean; onDismiss: () => void }) {
  const { sheetRef, handleProps } = useSwipeToDismiss<HTMLDivElement>({ enabled, onDismiss });

  return (
    <div ref={sheetRef} data-testid="sheet">
      <div data-testid="handle" {...handleProps}>
        grab here
      </div>
      <div data-testid="body">scrolls</div>
    </div>
  );
}

const sheet = () => screen.getByTestId('sheet');
const handle = () => screen.getByTestId('handle');

/** The handle's pointer events, all from the one finger the hook is told about. */
function pointer(type: 'Down' | 'Move' | 'Up' | 'Cancel', clientY: number, init: PointerEventInit = {}) {
  const fire = {
    Down: fireEvent.pointerDown,
    Move: fireEvent.pointerMove,
    Up: fireEvent.pointerUp,
    Cancel: fireEvent.pointerCancel,
  }[type];

  fire(handle(), { pointerId: 1, isPrimary: true, button: 0, clientY, ...init });
}

/** Put a finger down at y=100, drag it to `to`, and let go `ms` later. */
function drag(to: number, ms = 400) {
  pointer('Down', 100);
  pointer('Move', to);
  act(() => {
    vi.advanceTimersByTime(ms);
  });
  pointer('Up', to);
}

const realMatchMedia = window.matchMedia;

/** The reduced-motion preference is the only media query this hook reads. */
function preferReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = realMatchMedia;
});

describe('useSwipeToDismiss', () => {
  it('follows the finger down, with the sheet’s own transition switched off', () => {
    render(<Harness onDismiss={vi.fn()} />);

    pointer('Down', 100);
    pointer('Move', 160);

    expect(sheet().style.transform).toBe('translateY(60px)');
    // The sheet's classes ease transforms over 500ms; that would trail the finger.
    expect(sheet().style.transition).toBe('none');
  });

  it('never rides above where it started', () => {
    render(<Harness onDismiss={vi.fn()} />);

    pointer('Down', 100);
    pointer('Move', 40);

    expect(sheet().style.transform).toBe('');
  });

  it('dismisses when let go past the distance, after the sheet has slid away', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);

    drag(230);

    // Sliding out: closing is held until it is off the screen, so the sheet is
    // not simply deleted from under the finger.
    expect(sheet().style.transform).toBe('translateY(100%)');
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(180);
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses a short, fast flick', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);

    // 40px in 50ms: nowhere near the distance, but unmistakably a flick.
    drag(140, 50);
    act(() => {
      vi.advanceTimersByTime(180);
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('brings the sheet back when a slow drag is let go short', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);

    drag(150, 600);

    expect(sheet().style.transform).toBe('');

    act(() => {
      vi.advanceTimersByTime(180);
    });

    expect(onDismiss).not.toHaveBeenCalled();
    // And the sheet's own transition is handed back, not left on the inline style.
    expect(sheet().style.transition).toBe('');
  });

  it('does not dismiss when the system takes the touch (pointercancel)', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);

    pointer('Down', 100);
    pointer('Move', 400);
    pointer('Cancel', 400);
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(sheet().style.transform).toBe('');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('keeps the handle from being taken for a scroll, and nothing else', () => {
    render(<Harness onDismiss={vi.fn()} />);

    expect(handle().style.touchAction).toBe('none');
    // The body is not the handle: it has to stay scrollable.
    expect(screen.getByTestId('body').style.touchAction).not.toBe('none');
  });

  it('follows only the primary pointer', () => {
    render(<Harness onDismiss={vi.fn()} />);

    // A second finger.
    pointer('Down', 100, { isPrimary: false, pointerId: 2 });
    pointer('Move', 300, { pointerId: 2 });

    expect(sheet().style.transform).toBe('');
  });

  it('ignores another pointer’s moves while a drag is under way', () => {
    render(<Harness onDismiss={vi.fn()} />);

    pointer('Down', 100);
    pointer('Move', 500, { pointerId: 2 });

    expect(sheet().style.transform).toBe('');
  });

  it('cannot be pulled back in once it is on its way out', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);

    drag(230);

    // A touch landing while it slides away must not cancel the dismissal.
    pointer('Down', 100);
    pointer('Up', 100);
    act(() => {
      vi.advanceTimersByTime(180);
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(sheet().style.transform).toBe('translateY(100%)');
  });

  it('is inert when disabled: no gesture, no touch-action, no transform', () => {
    const onDismiss = vi.fn();
    render(<Harness enabled={false} onDismiss={onDismiss} />);

    drag(400);

    expect(handle().style.touchAction).not.toBe('none');
    expect(sheet().style.transform).toBe('');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('skips the slide, and dismisses at once, for someone who asked for less motion', () => {
    preferReducedMotion(true);
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);

    drag(230);

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('calls the latest onDismiss, not the one it first saw', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Harness onDismiss={first} />);

    rerender(<Harness onDismiss={second} />);
    drag(230);
    act(() => {
      vi.advanceTimersByTime(180);
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
