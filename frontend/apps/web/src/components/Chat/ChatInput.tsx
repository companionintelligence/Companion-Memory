import {
  type BaseSyntheticEvent,
  type FormEvent,
  type ForwardedRef,
  type KeyboardEvent,
  type MouseEvent,
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
} from 'react';

import {
  Button,
  Form,
  Tooltip,
  cn,
  useForm,
  formDataResolver,
  formDataSchema as s,
} from '@ci/shadcn';
import { Send, Square, Mic, Plus } from '@ci/shadcn/icons';
import { MarkdownEditor, type MarkdownEditorRef } from './MarkdownEditor';

const FormSchema = s.object({
  message: s.string(),
});

export type FormData = s.infer<typeof FormSchema>;

const EMPTY: FormData = {
  message: '',
};

const handleEnterSubmit = (e: KeyboardEvent<HTMLDivElement>) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    e.currentTarget.closest('form')?.requestSubmit();
  }
};

interface Props {
  disabled?: boolean;
  loading?: boolean;
  streaming?: boolean;
  placeholder?: string;
  onAttach?: (e: MouseEvent<HTMLButtonElement>) => void | Promise<void>;
  onRecord?: (e: MouseEvent<HTMLButtonElement>) => void | Promise<void>;
  onStop?: (e: MouseEvent<HTMLButtonElement>) => void | Promise<void>;
  onSubmit?: (data: FormData, e?: FormEvent<HTMLFormElement>) => boolean | void | Promise<boolean | void>;
}

function ChatInput(
  {
    disabled = false,
    loading = false,
    streaming = false,
    placeholder,
    onAttach,
    onRecord,
    onSubmit,
    onStop,
  }: Props,
  forwardedRef: ForwardedRef<HTMLTextAreaElement>,
) {
  const SendIcon = streaming ? Square : Send;
  const sendIconClassName = streaming ? '' : 'left-[-0.5px] top-[0.5px]';
  const editorRef = useRef<MarkdownEditorRef>(null);

  const form = useForm<FormData>({
    resolver: formDataResolver(FormSchema),
    defaultValues: EMPTY,
  });

  // Forward ref to the editor
  useImperativeHandle(forwardedRef, () => editorRef.current as any, []);

  const handleAttach = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      onAttach?.(e);
    },
    [onAttach],
  );

  const handleRecord = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      onRecord?.(e);
    },
    [onRecord],
  );

  const handleStop = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();

      onStop?.(e);
    },
    [onStop],
  );

  const handleSubmit = useCallback(
    async (data: FormData, e?: BaseSyntheticEvent) => {
      e?.preventDefault();

      if (data.message.trim()) {
        const success = await onSubmit?.(data, e as FormEvent<HTMLFormElement>);

        if (success === true) {
          form.reset();
        }
      }
    },
    [form, onSubmit],
  );

  return (
    <Tooltip.Provider>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <div className="w-full flex items-center gap-2">
            <Tooltip>
              <Tooltip.Content side="bottom">Attach content</Tooltip.Content>
              <Tooltip.Trigger asChild>
                <Button
                  type="button"
                  disabled={loading || streaming || disabled}
                  size="sm"
                  variant="ghost"
                  className="cursor-pointer h-8 w-8 p-0 -mr-1 active:scale-90 transition-transform duration-200 ease-out will-change-transform"
                  onClick={handleAttach}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </Tooltip.Trigger>
            </Tooltip>

            <div
              className="
                w-full
                flex
                items-center
                gap-1.5
                p-1.5

                placeholder:text-muted-foreground/60
                dark:bg-input/30
                field-sizing-content

                outline-none
                border
                shadow-xs
                rounded-md

                bg-transparent

                text-base

                focus-within:border-ring
                focus-within:ring-[2px]
                focus-within:ring-ring/30

                aria-[invalid=true]:ring-destructive/20
                dark:aria-[invalid=true]:ring-destructive/40
                aria-[invalid=true]:border-destructive

                disabled:cursor-not-allowed
                disabled:opacity-50
                transition-[color,box-shadow]

                md:text-sm
              "
            >
              <Form.Field
                control={form.control}
                name="message"
                render={({ field }) => (
                  <MarkdownEditor
                    ref={editorRef}
                    value={field.value}
                    onChange={field.onChange}
                    placeholder={placeholder}
                    disabled={loading || streaming || disabled}
                    onKeyDown={handleEnterSubmit}
                    className="
                      !w-full
                      !flex-1
                      !min-h-0
                      !ml-1
                    "
                  />
                )}
              />

              <Tooltip>
                <Tooltip.Content side="bottom">Dictate</Tooltip.Content>
                <Tooltip.Trigger asChild>
                  <Button
                    type="button"
                    disabled={loading || streaming || disabled}
                    size="sm"
                    variant="ghost"
                    className="cursor-pointer h-8 w-8 p-0 active:scale-90 transition-transform duration-200 ease-out will-change-transform"
                    onClick={handleRecord}
                  >
                    <Mic className="h-4 w-4" />
                  </Button>
                </Tooltip.Trigger>
              </Tooltip>

              <Tooltip>
                <Tooltip.Content side="bottom">{streaming ? 'Stop' : 'Send'}</Tooltip.Content>
                <Tooltip.Trigger asChild>
                  <Button
                    type={streaming ? 'button' : 'submit'}
                    disabled={loading || disabled}
                    size="sm"
                    className="cursor-pointer h-8 w-8 p-0 active:scale-90 transition-transform duration-200 ease-out will-change-transform"
                    onClick={streaming ? handleStop : undefined}
                  >
                    <SendIcon className={cn('h-4 w-4 relative', sendIconClassName)} />
                  </Button>
                </Tooltip.Trigger>
              </Tooltip>
            </div>
          </div>
        </form>
      </Form>
    </Tooltip.Provider>
  );
}

const ChatInputForwarded = forwardRef(ChatInput);

export { ChatInputForwarded as ChatInput };
