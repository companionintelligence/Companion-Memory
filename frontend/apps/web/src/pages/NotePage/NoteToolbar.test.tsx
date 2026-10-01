import { Editor } from '@ci/editor';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

/**
 * The note toolbar with the real editor behind it. On a phone the formatting
 * buttons are about twice as wide as the screen, so they must scroll sideways,
 * and whatever the page puts at the end (save status, chat) must stay put.
 */
describe('note editor toolbar', () => {
  function renderToolbar() {
    return render(
      <Editor content="<p>Hello</p>">
        <Editor.Menu>
          <span>Saved</span>
        </Editor.Menu>
      </Editor>,
    );
  }

  it('names every formatting button', () => {
    renderToolbar();

    for (const name of [
      'Bold',
      'Italic',
      'Strikethrough',
      'Text style',
      'Bulleted list',
      'Numbered list',
      'Quote',
      'Inline code',
      'Code block',
      'Divider',
    ]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('puts the formatting buttons in a sideways-scrolling row and keeps the trailing slot outside it', () => {
    renderToolbar();

    const row = screen.getByRole('button', { name: 'Bold' }).closest('.overflow-x-auto');
    const slot = screen.getByText('Saved').parentElement;

    expect(row).not.toBeNull();
    expect(row).toContainElement(screen.getByRole('button', { name: 'Divider' }));
    expect(row).not.toContainElement(slot);
    expect(slot).toHaveClass('shrink-0');
  });
});
