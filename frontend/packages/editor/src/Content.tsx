import type { MouseEvent } from 'react';

import { EditorContent } from '@tiptap/react';
import { cn } from '@ci/shadcn';

import { useEditor } from './useEditor';

interface Props {
  className?: string;
  /**
   * Called when a `[[` reference chip is activated. The editor is editable, so
   * anchors do not navigate on their own — the host handles it, which also
   * keeps routing out of this package.
   */
  onReferenceClick?: (reference: { uid: string; type: string; label: string }) => void;
}

export function Content({ className, onReferenceClick }: Props) {
  const editor = useEditor();

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!onReferenceClick) {
      return;
    }

    const anchor = (event.target as HTMLElement).closest?.('[data-entity-uid]');

    if (!(anchor instanceof HTMLElement)) {
      return;
    }

    const uid = anchor.getAttribute('data-entity-uid');
    const type = anchor.getAttribute('data-entity-type');

    if (!uid || !type) {
      return;
    }

    event.preventDefault();
    onReferenceClick({
      uid,
      type,
      label: anchor.getAttribute('data-entity-label') ?? anchor.textContent ?? '',
    });
  };

  return (
    <EditorContent
      editor={editor}
      onClick={handleClick}
      className={cn(
        'prose dark:prose-invert max-w-none min-h-full focus:outline-none',
        '[&_.ProseMirror]:focus:outline-none [&_.ProseMirror]:min-h-full [&_.ProseMirror]:p-3 [&_.ProseMirror]:text-base device:[&_.ProseMirror]:p-4',
        'prose-p:leading-tight prose-headings:leading-tight [&_h1]:mt-4 [&_h2]:mt-3 [&_h3]:mt-2 [&_p]:mt-0 [&_p]:mb-4',
        // Reference chips: a tinted inline pill, distinct from ordinary links
        // and from surrounding prose, with no underline so it reads as an object.
        '[&_.ci-entity-reference]:rounded [&_.ci-entity-reference]:bg-primary/10 [&_.ci-entity-reference]:px-1 [&_.ci-entity-reference]:py-0.5',
        '[&_.ci-entity-reference]:font-medium [&_.ci-entity-reference]:text-primary [&_.ci-entity-reference]:no-underline',
        '[&_.ci-entity-reference]:cursor-pointer hover:[&_.ci-entity-reference]:bg-primary/20',
        className,
      )}
    />
  );
}
