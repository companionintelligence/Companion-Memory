import { type ReactNode } from 'react';
import { useEditorState } from '@tiptap/react';
import { Button, DropdownMenu, Separator } from '@ci/shadcn';
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Type,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  List,
  ListOrdered,
  Code2,
  Quote,
  Minus,
  ChevronDown,
} from '@ci/shadcn/icons';

import { useEditor } from './useEditor';

interface Props {
  children?: ReactNode;
}

export function Menu({ children }: Props) {
  const editor = useEditor();

  const editorState = useEditorState({
    editor,
    selector: (ctx) => {
      return {
        isBold: ctx.editor.isActive('bold') ?? false,
        canBold: ctx.editor.can().chain().toggleBold().run() ?? false,
        isItalic: ctx.editor.isActive('italic') ?? false,
        canItalic: ctx.editor.can().chain().toggleItalic().run() ?? false,
        isStrike: ctx.editor.isActive('strike') ?? false,
        canStrike: ctx.editor.can().chain().toggleStrike().run() ?? false,
        isCode: ctx.editor.isActive('code') ?? false,
        canCode: ctx.editor.can().chain().toggleCode().run() ?? false,
        isParagraph: ctx.editor.isActive('paragraph') ?? false,
        isHeading1: ctx.editor.isActive('heading', { level: 1 }) ?? false,
        isHeading2: ctx.editor.isActive('heading', { level: 2 }) ?? false,
        isHeading3: ctx.editor.isActive('heading', { level: 3 }) ?? false,
        isHeading4: ctx.editor.isActive('heading', { level: 4 }) ?? false,
        isHeading5: ctx.editor.isActive('heading', { level: 5 }) ?? false,
        isHeading6: ctx.editor.isActive('heading', { level: 6 }) ?? false,
        isBulletList: ctx.editor.isActive('bulletList') ?? false,
        isOrderedList: ctx.editor.isActive('orderedList') ?? false,
        isCodeBlock: ctx.editor.isActive('codeBlock') ?? false,
        isBlockquote: ctx.editor.isActive('blockquote') ?? false,
      };
    },
  });

  return (
    <div className="flex gap-1 p-1 items-center border-b border-border bg-muted/10">
      <div className="flex flex-1 gap-1 items-center">
        <div className="flex gap-1">
          <Button
            variant={editorState.isBold ? 'default' : 'ghost'}
            size="sm"
            onClick={() => editor.chain().focus().toggleBold().run()}
            disabled={!editorState.canBold}
          >
            <Bold className="h-4 w-4" />
          </Button>

          <Button
            variant={editorState.isItalic ? 'default' : 'ghost'}
            size="sm"
            onClick={() => editor.chain().focus().toggleItalic().run()}
            disabled={!editorState.canItalic}
          >
            <Italic className="h-4 w-4" />
          </Button>

          <Button
            variant={editorState.isStrike ? 'default' : 'ghost'}
            size="sm"
            onClick={() => editor.chain().focus().toggleStrike().run()}
            disabled={!editorState.canStrike}
          >
            <Strikethrough className="h-4 w-4" />
          </Button>
        </div>

        <Separator orientation="vertical" className="data-[orientation=vertical]:h-6" />

        <div className="flex gap-1">
          <DropdownMenu>
            <DropdownMenu.Trigger asChild>
              <Button variant="ghost" size="sm" className="gap-1">
                {editorState.isHeading1 ? (
                  <Heading1 className="h-4 w-4" />
                ) : editorState.isHeading2 ? (
                  <Heading2 className="h-4 w-4" />
                ) : editorState.isHeading3 ? (
                  <Heading3 className="h-4 w-4" />
                ) : editorState.isHeading4 ? (
                  <Heading4 className="h-4 w-4" />
                ) : editorState.isHeading5 ? (
                  <Heading5 className="h-4 w-4" />
                ) : editorState.isHeading6 ? (
                  <Heading6 className="h-4 w-4" />
                ) : (
                  <Type className="h-4 w-4" />
                )}
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              <DropdownMenu.Item onClick={() => editor.chain().focus().setParagraph().run()}>
                <Type className="h-4 w-4 mr-1" />
                Text
              </DropdownMenu.Item>
              <DropdownMenu.Item onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
                <Heading1 className="h-4 w-4 mr-1" />
                Heading 1
              </DropdownMenu.Item>
              <DropdownMenu.Item onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
                <Heading2 className="h-4 w-4 mr-1" />
                Heading 2
              </DropdownMenu.Item>
              <DropdownMenu.Item onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
                <Heading3 className="h-4 w-4 mr-1" />
                Heading 3
              </DropdownMenu.Item>
              <DropdownMenu.Item onClick={() => editor.chain().focus().toggleHeading({ level: 4 }).run()}>
                <Heading4 className="h-4 w-4 mr-1" />
                Heading 4
              </DropdownMenu.Item>
              <DropdownMenu.Item onClick={() => editor.chain().focus().toggleHeading({ level: 5 }).run()}>
                <Heading5 className="h-4 w-4 mr-1" />
                Heading 5
              </DropdownMenu.Item>
              <DropdownMenu.Item onClick={() => editor.chain().focus().toggleHeading({ level: 6 }).run()}>
                <Heading6 className="h-4 w-4 mr-1" />
                Heading 6
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu>
        </div>

        <Separator orientation="vertical" className="data-[orientation=vertical]:h-6" />

        <div className="flex gap-1">
          <Button
            variant={editorState.isBulletList ? 'default' : 'ghost'}
            size="sm"
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            <List className="h-4 w-4" />
          </Button>

          <Button
            variant={editorState.isOrderedList ? 'default' : 'ghost'}
            size="sm"
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          >
            <ListOrdered className="h-4 w-4" />
          </Button>

          <Button
            variant={editorState.isBlockquote ? 'default' : 'ghost'}
            size="sm"
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          >
            <Quote className="h-4 w-4" />
          </Button>
        </div>

        <Separator orientation="vertical" className="data-[orientation=vertical]:h-6" />

        <div className="flex gap-1">
          <Button
            variant={editorState.isCode ? 'default' : 'ghost'}
            size="sm"
            onClick={() => editor.chain().focus().toggleCode().run()}
            disabled={!editorState.canCode}
          >
            <Code className="h-4 w-4" />
          </Button>

          <Button
            variant={editorState.isCodeBlock ? 'default' : 'ghost'}
            size="sm"
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          >
            <Code2 className="h-4 w-4" />
          </Button>
        </div>

        <Separator orientation="vertical" className="data-[orientation=vertical]:h-6" />

        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
            <Minus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {children && <div className="flex items-center">{children}</div>}
    </div>
  );
}
