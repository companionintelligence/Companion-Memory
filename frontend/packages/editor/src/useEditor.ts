import { useEffect, useMemo } from 'react';

import { createHookContext } from '@ci/common';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { useEditor as useTiptapEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

import { createEntityReference } from './EntityReference';
import type { EntityReferenceConfig } from './EntityReference';

const baseExtensions = [TextStyleKit, StarterKit];

interface Props {
  content?: string;
  onUpdate?: (content: string) => void;
  /**
   * Enables `[[` references to notes and other entities. Omit to get a plain
   * editor. Must be referentially stable — the extension list is rebuilt when
   * it changes, which recreates the editor — so hosts should memoize it.
   */
  reference?: EntityReferenceConfig;
}

function useEditor({ content, onUpdate, reference }: Props) {
  const extensions = useMemo(
    () => (reference ? [...baseExtensions, createEntityReference(reference)] : baseExtensions),
    [reference],
  );

  const editor = useTiptapEditor({
    extensions,
    content: content ? content : undefined,
    autofocus: true,
    onUpdate: ({ editor }) => {
      onUpdate?.(editor.getHTML());
    },
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        editor?.commands.blur();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [editor]);

  return editor;
}

const { Provider, useHookContext } = createHookContext(useEditor);

export { Provider as EditorProvider, useHookContext as useEditor };
