import { Editor } from '@ci/editor';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The real editor, driven the way a person does: Enter and the list and quote
 * buttons. Each of these builds new nodes. When two copies of
 * prosemirror-model are installed they throw "Can not convert <> to a
 * Fragment (looks like multiple versions of prosemirror-model were loaded)"
 * and leave the note unchanged.
 */
describe('note editor commands', () => {
  beforeAll(() => {
    // jsdom has no layout. ProseMirror measures the selection to scroll it into
    // view after each change, so give ranges an empty box to measure.
    Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  });

  function renderEditor() {
    const onUpdate = vi.fn<(content: string) => void>();

    render(
      <Editor content="<p>Shopping list</p>" onUpdate={onUpdate}>
        <Editor.Menu />
        <Editor.Content />
      </Editor>,
    );

    return { lastHtml: () => onUpdate.mock.lastCall?.[0] };
  }

  it('starts a new paragraph on Enter', async () => {
    const { lastHtml } = renderEditor();
    const editable = await screen.findByRole('textbox');

    // The editor autofocuses with the caret at the start, a tick after it
    // mounts. Wait for that to land, or it puts the caret back after we move it.
    await waitFor(() => expect(editable).toHaveFocus());

    // Put the caret after "Shopping list", where a person starts the next line.
    const text = editable.querySelector('p')?.firstChild as Text;
    window.getSelection()?.collapse(text, text.length);
    document.dispatchEvent(new Event('selectionchange'));

    fireEvent.keyDown(editable, { key: 'Enter', code: 'Enter', keyCode: 13 });

    await waitFor(() => expect(lastHtml()).toBe('<p>Shopping list</p><p></p>'));
  });

  it.each([
    ['Bulleted list', '<ul>'],
    ['Numbered list', '<ol>'],
    ['Quote', '<blockquote>'],
  ])('%s wraps the paragraph', async (name, tag) => {
    const { lastHtml } = renderEditor();
    await screen.findByRole('textbox');

    fireEvent.click(screen.getByRole('button', { name }));

    await waitFor(() => expect(lastHtml()).toContain(tag));
    expect(lastHtml()).toContain('Shopping list');
  });
});
