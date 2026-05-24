import { EditorContent } from '@tiptap/react';
import { cn } from '@ci/shadcn';

import { useEditor } from './useEditor';

interface Props {
  className?: string;
}

export function Content({ className }: Props) {
  const editor = useEditor();

  return (
    <EditorContent
      editor={editor}
      className={cn(
        'prose dark:prose-invert max-w-none min-h-full focus:outline-none',
        '[&_.ProseMirror]:focus:outline-none [&_.ProseMirror]:min-h-full [&_.ProseMirror]:p-6',
        'prose-p:leading-tight prose-headings:leading-tight [&_h1]:mt-4 [&_h2]:mt-3 [&_h3]:mt-2 [&_p]:mt-0 [&_p]:mb-4',
        className,
      )}
    />
  );
}
