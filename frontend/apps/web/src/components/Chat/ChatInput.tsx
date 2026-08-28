import {
  type BaseSyntheticEvent,
  type ChangeEvent,
  type FormEvent,
  type ForwardedRef,
  type KeyboardEvent,
  type MouseEvent,
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
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
  useToast,
} from '@ci/shadcn';
import { Paperclip, Send, Square, X } from '@ci/shadcn/icons';

import type { File as FileData } from '@/api/types';
import { useUploadFile } from '@/api/useUploadFile';
import { ModelSelector } from '@/components/ModelSelector';

const FormSchema = s.object({
  message: s.string(),
  fileIds: s.array(s.string()).optional(),
});

export type FormData = s.infer<typeof FormSchema>;

const handleEnterSubmit = (e: KeyboardEvent<HTMLTextAreaElement>) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    e.currentTarget.form?.requestSubmit();
  }
};

const ATTACH_ACCEPT = 'image/*,application/pdf,text/plain,text/markdown,text/csv,.txt,.md,.pdf,.json';

interface Props {
  disabled?: boolean;
  loading?: boolean;
  streaming?: boolean;
  placeholder?: string;
  initialDraft?: string;
  /** Tools / thinking / model row. Off in Capture, which has its own selector. */
  showModelControls?: boolean;
  onStop?: (e: MouseEvent<HTMLButtonElement>) => void | Promise<void>;
  onSubmit?: (data: FormData, e?: FormEvent<HTMLFormElement>) => boolean | void | Promise<boolean | void>;
}

function ChatInput(
  {
    disabled = false,
    loading = false,
    streaming = false,
    placeholder,
    initialDraft = '',
    showModelControls = true,
    onSubmit,
    onStop,
  }: Props,
  forwardedRef: ForwardedRef<HTMLTextAreaElement>,
) {
  const SendIcon = streaming ? Square : Send;
  const sendIconClassName = streaming ? '' : 'left-[-0.5px] top-[0.5px]';
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<FileData[]>([]);
  const [{ files: uploadedFiles, loading: uploading }, { upload }] = useUploadFile();

  const form = useForm<FormData>({
    resolver: formDataResolver(FormSchema),
    defaultValues: { message: initialDraft, fileIds: [] },
  });
  const { reset, getValues } = form;

  useEffect(() => {
    reset({ message: initialDraft, fileIds: getValues('fileIds') ?? [] });
  }, [getValues, initialDraft, reset]);

  useEffect(() => {
    if (uploadedFiles.length === 0) {
      return;
    }

    setAttachments((current) => {
      const seen = new Set(current.map((file) => file.id));
      const next = uploadedFiles.filter((file) => !seen.has(file.id));

      return next.length === 0 ? current : [...current, ...next];
    });
  }, [uploadedFiles]);

  const handleStop = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();

      onStop?.(e);
    },
    [onStop],
  );

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFilesSelected = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(event.target.files ?? []);
      event.target.value = '';

      if (selected.length === 0) {
        return;
      }

      const success = await upload(selected);

      if (!success) {
        toast.error('Could not attach that file. Try again.');
      }
    },
    [toast, upload],
  );

  const handleRemoveAttachment = useCallback((fileId: string) => {
    setAttachments((current) => current.filter((file) => file.id !== fileId));
  }, []);

  const handleSubmit = useCallback(
    async (data: FormData, e?: BaseSyntheticEvent) => {
      e?.preventDefault();

      const message = data.message.trim();
      const fileIds = attachments.map((file) => file.id);

      if (!message && fileIds.length === 0) {
        return;
      }

      const success = await onSubmit?.(
        {
          message: message || 'Please look at the attached file(s).',
          fileIds,
        },
        e as FormEvent<HTMLFormElement>,
      );

      if (success === true) {
        form.reset({ message: '', fileIds: [] });
        setAttachments([]);
      }
    },
    [attachments, form, onSubmit],
  );

  const inputDisabled = loading || streaming || disabled || uploading;

  return (
    <Tooltip.Provider>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <div
            className="
              w-full
              flex
              flex-col
              gap-2
              p-2

              placeholder:text-muted-foreground/60
              dark:bg-input/30

              outline-none
              border
              shadow-xs
              rounded-xl

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
                  disabled={inputDisabled}
                  className="
                    !w-full
                    !min-h-12
                    !max-h-48
                    !bg-transparent
                    !border-0
                    !outline-none
                    !ring-0
                    !shadow-none
                    !rounded-none
                    !p-0
                    !px-1.5
                    !pt-1

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

            {attachments.length > 0 && (
              <ul className="flex flex-wrap gap-1.5 px-1.5">
                {attachments.map((file) => (
                  <li
                    key={file.id}
                    className="flex max-w-full items-center gap-1 rounded-md border bg-muted/60 px-2 py-0.5 text-xs"
                  >
                    <span className="truncate">{file.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                      onClick={() => handleRemoveAttachment(file.id)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex items-center justify-between gap-2">
              {showModelControls ? <ModelSelector withToggles variant="composer" /> : <span />}

              <div className="flex items-center gap-1">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={ATTACH_ACCEPT}
                  className="sr-only"
                  onChange={(event) => void handleFilesSelected(event)}
                />

                <Tooltip>
                  <Tooltip.Content side="bottom">Attach files or images</Tooltip.Content>
                  <Tooltip.Trigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={inputDisabled}
                      aria-label="Attach files or images"
                      className="h-8 w-8 p-0"
                      onClick={handleAttachClick}
                    >
                      <Paperclip className="h-4 w-4" />
                    </Button>
                  </Tooltip.Trigger>
                </Tooltip>

                <Tooltip>
                  <Tooltip.Content side="bottom">{streaming ? 'Stop' : 'Send'}</Tooltip.Content>
                  <Tooltip.Trigger asChild>
                    <Button
                      type={streaming ? 'button' : 'submit'}
                      disabled={loading || disabled || uploading}
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
          </div>
        </form>
      </Form>
    </Tooltip.Provider>
  );
}

const ChatInputForwarded = forwardRef(ChatInput);

export { ChatInputForwarded as ChatInput };
