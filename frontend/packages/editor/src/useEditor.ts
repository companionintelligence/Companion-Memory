import { useEffect } from 'react';

import { createHookContext } from '@ci/common';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { useEditor as useTiptapEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

const extensions = [TextStyleKit, StarterKit];

interface Props {
  content?: string;
  onUpdate?: (content: string) => void;
}

function useEditor({ content, onUpdate }: Props) {
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
