import { createRef } from 'react';

import { ReferenceList, type ReferenceListHandle } from '@ci/editor/src/EntityReference/ReferenceList';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The `[[` menu is driven entirely through an imperative handle — the suggestion
 * plugin forwards keydowns rather than letting the list take focus, because the
 * editor selection has to stay put while the user is choosing. That makes the
 * keyboard path invisible to ordinary DOM-event testing, so it is asserted
 * against the handle directly.
 *
 * This lives in the web app rather than beside the component because
 * `@ci/editor` has no test runner of its own; fe-web's vitest only collects
 * `src/**`.
 */

const ITEMS = [
  { uid: 'uid-1', type: 'note', label: 'Weekly review' },
  { uid: 'uid-2', type: 'person', label: 'Rajaa Asad' },
  { uid: 'uid-3', type: 'place', label: 'Reykjavík' },
];

function renderList(items = ITEMS) {
  const ref = createRef<ReferenceListHandle>();
  const command = vi.fn();

  render(<ReferenceList ref={ref} items={items} command={command} />);

  /** Feed one key through the handle, then let the highlight state settle. */
  const press = (name: string) => {
    let consumed = false;

    act(() => {
      consumed = ref.current!.onKeyDown(new KeyboardEvent('keydown', { key: name }));
    });

    return consumed;
  };

  return { press, command };
}

/** The highlighted row is the one carrying the accent background. */
function highlighted() {
  const row = screen.getAllByRole('button').find((button) => button.className.includes('bg-accent'));

  return row?.textContent ?? null;
}

describe('ReferenceList', () => {
  it('starts on the first result', () => {
    renderList();

    expect(highlighted()).toContain('Weekly review');
  });

  it('moves down and wraps past the last result', () => {
    const { press } = renderList();

    expect(press('ArrowDown')).toBe(true);
    expect(highlighted()).toContain('Rajaa Asad');

    press('ArrowDown');
    expect(highlighted()).toContain('Reykjavík');

    press('ArrowDown');
    expect(highlighted()).toContain('Weekly review');
  });

  it('moves up and wraps past the first result', () => {
    const { press } = renderList();

    expect(press('ArrowUp')).toBe(true);
    expect(highlighted()).toContain('Reykjavík');
  });

  it('inserts the highlighted result on Enter and on Tab', () => {
    const { press, command } = renderList();

    press('ArrowDown');

    expect(press('Enter')).toBe(true);
    expect(command).toHaveBeenLastCalledWith(ITEMS[1]);

    expect(press('Tab')).toBe(true);
    expect(command).toHaveBeenLastCalledWith(ITEMS[1]);
  });

  it('leaves other keys — Escape included — to the suggestion plugin', () => {
    const { press, command } = renderList();

    // Consuming Escape here would suppress @tiptap/suggestion's exit path and
    // strand the menu on screen. See EntityReference.ts.
    expect(press('Escape')).toBe(false);
    expect(press('a')).toBe(false);
    expect(command).not.toHaveBeenCalled();
  });

  it('consumes nothing and offers a hint when there are no matches', () => {
    const { press, command } = renderList([]);

    expect(screen.getByText(/No matches/i)).toBeInTheDocument();
    expect(press('ArrowDown')).toBe(false);
    expect(press('Enter')).toBe(false);
    expect(command).not.toHaveBeenCalled();
  });

  it('labels each row with its entity type', () => {
    renderList();

    expect(screen.getByText('Note')).toBeInTheDocument();
    expect(screen.getByText('Person')).toBeInTheDocument();
    expect(screen.getByText('Place')).toBeInTheDocument();
  });
});
