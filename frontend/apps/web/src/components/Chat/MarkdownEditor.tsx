import {
  type ForwardedRef,
  type KeyboardEvent,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { EditorView } from 'prosemirror-view';
import { EditorState } from 'prosemirror-state';
import { schema } from 'prosemirror-schema-basic';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import { defaultMarkdownParser, defaultMarkdownSerializer } from 'prosemirror-markdown';
import { cn } from '@ci/shadcn';

interface MarkdownEditorProps {
  value?: string;
  onChange?: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export interface MarkdownEditorRef {
  getValue: () => string;
  setValue: (value: string) => void;
  focus: () => void;
  blur: () => void;
}

function MarkdownEditor(
  {
    value = '',
    onChange,
    onKeyDown,
    placeholder = 'Type your message...',
    disabled = false,
    className,
  }: MarkdownEditorProps,
  forwardedRef: ForwardedRef<MarkdownEditorRef>,
) {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useImperativeHandle(
    forwardedRef,
    () => ({
      getValue: () => {
        if (viewRef.current) {
          return defaultMarkdownSerializer.serialize(viewRef.current.state.doc);
        }

        return '';
      },
      setValue: (newValue: string) => {
        if (viewRef.current) {
          const doc = defaultMarkdownParser.parse(newValue || '');
          if (doc) {
            const tr = viewRef.current.state.tr.replaceWith(
              0,
              viewRef.current.state.doc.content.size,
              doc.content,
            );
            viewRef.current.dispatch(tr);
          }
        }
      },
      focus: () => {
        viewRef.current?.focus();
      },
      blur: () => {
        if (viewRef.current?.dom instanceof HTMLElement) {
          viewRef.current.dom.blur();
        }
      },
    }),
    [],
  );

  useEffect(() => {
    if (!editorRef.current) {
      return;
    }

    const initialDoc =
      defaultMarkdownParser.parse(value || '') || schema.node('doc', null, [schema.node('paragraph')]);
    const state = EditorState.create({
      doc: initialDoc,
      plugins: [
        keymap({
          ...baseKeymap,
          Enter: () => {
            // Let the parent component handle Enter key for form submission
            if (onKeyDown) {
              const event = new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
              });
              setTimeout(() => {
                if (editorRef.current) {
                  onKeyDown(event as unknown as KeyboardEvent<HTMLDivElement>);
                }
              }, 0);
            }

            return false; // Don't handle it here, let parent handle
          },
          'Shift-Enter': (state, dispatch) => {
            // Insert a hard break for Shift+Enter
            if (dispatch) {
              dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()));
            }

            return true;
          },
        }),
      ],
    });

    const view = new EditorView(editorRef.current, {
      state,
      dispatchTransaction: (tr) => {
        const newState = view.state.apply(tr);
        view.updateState(newState);

        if (tr.docChanged) {
          const markdown = defaultMarkdownSerializer.serialize(newState.doc);
          onChange?.(markdown);
        }
      },
      editable: () => !disabled,
      attributes: {
        class: cn(
          'ProseMirror',
          'prose prose-sm max-w-none outline-none',
          'prose-p:my-0 prose-p:leading-relaxed',
          'prose-headings:my-0',
          'prose-ul:my-0 prose-ol:my-0',
          'prose-li:my-0',
          'prose-blockquote:my-0',
          'prose-code:text-sm prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded',
          'prose-pre:my-0',
          disabled && 'opacity-50 cursor-not-allowed',
        ),
        'data-placeholder': placeholder,
        style: 'min-height: 1.5rem;',
      },
      handleDOMEvents: {
        keydown: (_view, event) => {
          onKeyDown?.(event as unknown as KeyboardEvent<HTMLDivElement>);

          return false;
        },
      },
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [onChange, onKeyDown, disabled, placeholder, className]);

  // Update value when prop changes
  useEffect(() => {
    if (viewRef.current && value !== undefined) {
      const currentMarkdown = defaultMarkdownSerializer.serialize(viewRef.current.state.doc);
      if (currentMarkdown !== value) {
        const doc = defaultMarkdownParser.parse(value || '');
        if (doc) {
          const tr = viewRef.current.state.tr.replaceWith(
            0,
            viewRef.current.state.doc.content.size,
            doc.content,
          );
          viewRef.current.dispatch(tr);
        }
      }
    }
  }, [value]);

  return (
    <div
      ref={editorRef}
      className={cn(
        'w-full flex-1 min-h-0',
        'text-base leading-relaxed',
        'focus-within:outline-none',
        // Add placeholder styles
        '[&_.ProseMirror]:min-h-[1.5rem]',
        '[&_.ProseMirror:empty:before]:content-[attr(data-placeholder)]',
        '[&_.ProseMirror:empty:before]:text-muted-foreground/60',
        '[&_.ProseMirror:empty:before]:pointer-events-none',
        '[&_.ProseMirror:empty:before]:absolute',
        className,
      )}
    />
  );
}

const MarkdownEditorForwarded = forwardRef(MarkdownEditor);

export { MarkdownEditorForwarded as MarkdownEditor };
