import { Editor, type EntityReferenceConfig } from '@ci/editor';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * A `[[` reference is stored only in the note's HTML, as
 * `<a data-entity-uid="…">`. Loading that HTML back must give the reference
 * node again. StarterKit's Link mark matches the same anchor. If it wins, the
 * reference turns into a plain link the next time the note opens.
 */

const reference: EntityReferenceConfig = {
  search: async () => [],
  resolveHref: ({ uid }) => `/people/${uid}`,
};

const SAVED =
  '<p>Trip ideas with <a data-entity-uid="cGVyc29uOjE=" data-entity-type="person" data-entity-label="John Doe" ' +
  'href="/people/cGVyc29uOjE=" class="ci-entity-reference">John Doe</a> </p>';

// The editor autofocuses. Focusing scrolls the caret into view, which asks a
// Range for its rects. jsdom has no layout and no Range geometry, so without
// these the scroll throws after the test has passed and the run exits 1.
beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});

/** The first anchor in the editable area, once the editor has mounted. */
function firstAnchor() {
  return waitFor(() => {
    const anchor = document.querySelector<HTMLAnchorElement>('.ProseMirror a');
    expect(anchor).not.toBeNull();

    return anchor as HTMLAnchorElement;
  });
}

/**
 * Runs the editor's click handlers the way ProseMirror does on a click at
 * `anchor` and returns whether one claimed it. jsdom can't map a click to a
 * document position, so this calls them directly.
 */
type ClickHandler = (view: unknown, pos: number, event: MouseEvent) => boolean;
type EditorDom = HTMLElement & {
  editor: {
    view: { someProp: (prop: 'handleClick', run: (handle: ClickHandler) => boolean) => boolean | undefined };
  };
};

function clickInEditor(anchor: HTMLAnchorElement) {
  // Tiptap keeps its editor on the editable element.
  const { view } = (document.querySelector('.ProseMirror') as EditorDom).editor;
  const event = new MouseEvent('click', { button: 0 });
  Object.defineProperty(event, 'target', { value: anchor });

  return view.someProp('handleClick', (handle) => handle(view, 1, event)) ?? false;
}

describe('note editor references', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads a saved reference as a reference, not a plain link', async () => {
    render(
      <Editor content={SAVED} reference={reference}>
        <Editor.Content />
      </Editor>,
    );

    const link = await firstAnchor();
    expect(link.getAttribute('data-entity-uid')).toBe('cGVyc29uOjE=');
    expect(link.getAttribute('data-entity-type')).toBe('person');
    expect(link.getAttribute('data-entity-label')).toBe('John Doe');
    // The Link mark renders target="_blank"; the reference doesn't.
    expect(link.getAttribute('target')).toBeNull();
  });

  it('still loads an ordinary link as a link', async () => {
    render(
      <Editor content='<p>See <a href="https://example.com/">the site</a></p>' reference={reference}>
        <Editor.Content />
      </Editor>,
    );

    const link = await firstAnchor();
    expect(link.getAttribute('href')).toBe('https://example.com/');
    expect(link.hasAttribute('data-entity-uid')).toBe(false);
  });

  it('leaves a click on a reference to the host instead of opening a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    render(
      <Editor content={SAVED} reference={reference}>
        <Editor.Content />
      </Editor>,
    );

    expect(clickInEditor(await firstAnchor())).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it('still opens an ordinary link in a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    render(
      <Editor content='<p>See <a href="https://example.com/">the site</a></p>' reference={reference}>
        <Editor.Content />
      </Editor>,
    );

    clickInEditor(await firstAnchor());

    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank');
  });
});
