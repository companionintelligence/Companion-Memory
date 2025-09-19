import {
  type BaseSyntheticEvent,
  type FormEvent,
  type ForwardedRef,
  type KeyboardEvent,
  type MouseEvent,
  forwardRef,
  useCallback,
} from 'react';

import {
  Button,
  Textarea,
  Form,
  Tooltip,
  cn,
  useForm,
  formDataResolver,
  formDataSchema as s,
} from '@ci/shadcn';
import { Send, Square, Speech } from '@ci/shadcn/icons';

const FormSchema = s.object({
  message: s.string(),
});

export type FormData = s.infer<typeof FormSchema>;

const EMPTY: FormData = {
  message: '',
};

const handleEnterSubmit = (e: KeyboardEvent<HTMLTextAreaElement>) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    e.currentTarget.form?.requestSubmit();
  }
};

interface Props {
  disabled?: boolean;
  loading?: boolean;
  streaming?: boolean;
  placeholder?: string;
  onStop?: (e: MouseEvent<HTMLButtonElement>) => void | Promise<void>;
  onSubmit?: (data: FormData, e?: FormEvent<HTMLFormElement>) => boolean | void | Promise<boolean | void>;
  onVoiceModeToggle?: () => void;
  isVoiceModeActive?: boolean;
}

function ChatInput(
  {
    disabled = false,
    loading = false,
    streaming = false,
    placeholder,
    onSubmit,
    onStop,
    onVoiceModeToggle,
    isVoiceModeActive = false,
  }: Props,
  forwardedRef: ForwardedRef<HTMLTextAreaElement>,
) {
  const SendIcon = streaming ? Square : Send;
  const sendIconClassName = streaming ? '' : 'left-[-0.5px] top-[0.5px]';

  const form = useForm<FormData>({
    resolver: formDataResolver(FormSchema),
    defaultValues: EMPTY,
  });

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

  const handleVoiceModeToggle = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      onVoiceModeToggle?.();
    },
    [onVoiceModeToggle],
  );

  return (
    <Tooltip.Provider>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <div className="w-full flex items-center">
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
                  <Textarea
                    {...field}
                    ref={forwardedRef}
                    placeholder={placeholder}
                    disabled={loading || streaming || disabled}
                    className="
                      !w-full
                      !flex-1
                      !min-h-0
                      !bg-transparent
                      !border-0
                      !outline-none
                      !ring-0
                      !shadow-none
                      !rounded-none
                      !p-0
                      !ml-1

                      focus:!ring-0
                      focus-visible:!ring-0
                      focus-visible:!border-transparent
                      focus:!border-transparent

                      disabled:!bg-transparent

                      resize-none
                      text-base
                      leading-relaxed
                    "
                    onKeyDown={handleEnterSubmit}
                  />
                )}
              />

              <Tooltip>
                <Tooltip.Content side="bottom">
                  {isVoiceModeActive ? 'Exit Voice Mode' : 'Voice Mode'}
                </Tooltip.Content>
                <Tooltip.Trigger asChild>
                  <Button
                    type="button"
                    disabled={loading || streaming || disabled}
                    size="sm"
                    variant={isVoiceModeActive ? 'default' : 'ghost'}
                    className={cn(
                      'cursor-pointer h-8 w-8 p-0 active:scale-90 transition-transform duration-200 ease-out will-change-transform',
                      isVoiceModeActive && 'bg-blue-500 hover:bg-blue-600 text-white',
                    )}
                    onClick={handleVoiceModeToggle}
                  >
                    <Speech className="h-4 w-4" />
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
