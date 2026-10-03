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
import { v7 as uuid7 } from 'uuid';

import type { File as FileData } from '@/api/types';
import { useUploadFile } from '@/api/useUploadFile';
import { ModelSelector, ToolsOffNotice } from '@/components/ModelSelector';

const FormSchema = s.object({
  message: s.string(),
  fileIds: s.array(s.string()).optional(),
  /** Bare base64 JPEG/PNG for an on-device vision model. Never uploaded; see `localImages`. */
  images: s.array(s.string()).optional(),
});

export type FormData = s.infer<typeof FormSchema>;

const handleEnterSubmit = (e: KeyboardEvent<HTMLTextAreaElement>) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    e.currentTarget.form?.requestSubmit();
  }
};

const ATTACH_ACCEPT = 'image/*,application/pdf,text/plain,text/markdown,text/csv,.txt,.md,.pdf,.json';

const UPLOADS_BLOCKED_MESSAGE =
  'Attachments need your Companion server. Switch off on-device-only mode to attach files.';

/** A phone photo is 3–12 MB; the native side downsizes before the vision encoder, so this is only a sanity cap. */
const MAX_LOCAL_IMAGES = 4;
const MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024;

interface LocalImage {
  id: string;
  name: string;
  /** Bare base64, no `data:` prefix — the shape the native plugin takes. */
  data: string;
}

/** Read a picked image as bare base64 (the part of a data URL after the comma). */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(reader.error ?? new Error('Could not read that image.'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';

      resolve(result.slice(result.indexOf(',') + 1));
    };

    reader.readAsDataURL(file);
  });
}

interface Props {
  disabled?: boolean;
  loading?: boolean;
  streaming?: boolean;
  placeholder?: string;
  initialDraft?: string;
  /** Tools / thinking / model row. Off in Capture, which has its own selector. */
  showModelControls?: boolean;
  /**
   * The on-device vision model answers this chat, so "attach" picks photos to read locally as base64
   * instead of uploading files to the appliance — nothing leaves the phone, and it works offline.
   */
  localImages?: boolean;
  /**
   * The chat is answered on this phone only, which promises nothing leaves the device. Attaching a file uploads it
   * to the appliance the moment it is picked — before any send is checked, and removing the chip never takes it
   * back — so while this is set "attach" explains itself and uploads nothing. Does not apply to `localImages`,
   * which never uploads.
   */
  blockUploads?: boolean;
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
    localImages: localImagesMode = false,
    blockUploads = false,
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
  const [localImages, setLocalImages] = useState<LocalImage[]>([]);
  const [{ files: uploadedFiles, loading: uploading }, { upload }] = useUploadFile();
  // What was picked, in order. `POST /api/files/upload` answers with ids only, so a chip's name has to come from here.
  const pickedNames = useRef<string[]>([]);

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

    // The ids come back in the order the files went up — unless the server folded identical files into one, and
    // then nothing says which name belongs to which id. A generic name beats a wrong one.
    const picked = pickedNames.current;
    const aligned = picked.length === uploadedFiles.length;

    setAttachments((current) => {
      const seen = new Set(current.map((file) => file.id));
      const next = uploadedFiles
        .map((file, index) => ({
          ...file,
          name: file.name || (aligned ? picked[index] : '') || 'Attachment',
        }))
        .filter((file) => !seen.has(file.id));

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
    // Refused before the picker opens, so it never offers what it cannot do without breaking the on-device promise.
    if (blockUploads && !localImagesMode) {
      toast.error(UPLOADS_BLOCKED_MESSAGE);

      return;
    }

    fileInputRef.current?.click();
  }, [blockUploads, localImagesMode, toast]);

  const handleFilesSelected = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(event.target.files ?? []);
      event.target.value = '';

      if (selected.length === 0) {
        return;
      }

      if (localImagesMode) {
        const images = selected.filter((file) => file.type.startsWith('image/'));

        if (images.length < selected.length) {
          toast.error('This on-device model can read photos only.');
        }

        const room = MAX_LOCAL_IMAGES - localImages.length;

        if (images.length > room) {
          toast.error(`You can attach up to ${MAX_LOCAL_IMAGES} photos.`);
        }

        try {
          const read = await Promise.all(
            images
              .slice(0, Math.max(0, room))
              .filter((file) => {
                if (file.size > MAX_LOCAL_IMAGE_BYTES) {
                  toast.error(`${file.name} is too large to read on this device.`);

                  return false;
                }

                return true;
              })
              .map(async (file) => ({ id: uuid7(), name: file.name, data: await readAsBase64(file) })),
          );

          setLocalImages((current) => [...current, ...read]);
        } catch {
          toast.error('Could not read that photo. Try again.');
        }

        return;
      }

      // The click guard above is the usual stop; this is the one that holds when a file arrives some other way.
      if (blockUploads) {
        toast.error(UPLOADS_BLOCKED_MESSAGE);

        return;
      }

      pickedNames.current = selected.map((file) => file.name);

      const success = await upload(selected);

      if (!success) {
        toast.error('Could not attach that file. Try again.');
      }
    },
    [blockUploads, localImages.length, localImagesMode, toast, upload],
  );

  const handleRemoveLocalImage = useCallback((imageId: string) => {
    setLocalImages((current) => current.filter((image) => image.id !== imageId));
  }, []);

  const handleRemoveAttachment = useCallback((fileId: string) => {
    setAttachments((current) => current.filter((file) => file.id !== fileId));
  }, []);

  const handleSubmit = useCallback(
    async (data: FormData, e?: BaseSyntheticEvent) => {
      e?.preventDefault();

      const message = data.message.trim();
      const fileIds = attachments.map((file) => file.id);

      const images = localImages.map((image) => image.data);

      if (!message && fileIds.length === 0 && images.length === 0) {
        return;
      }

      const success = await onSubmit?.(
        {
          message:
            message ||
            (images.length > 0 ? 'Describe the attached photo(s).' : 'Please look at the attached file(s).'),
          fileIds,
          ...(images.length > 0 ? { images } : {}),
        },
        e as FormEvent<HTMLFormElement>,
      );

      if (success === true) {
        form.reset({ message: '', fileIds: [] });
        setAttachments([]);
        setLocalImages([]);
      }
    },
    [attachments, form, localImages, onSubmit],
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

            {(attachments.length > 0 || localImages.length > 0) && (
              <ul className="flex flex-wrap gap-1.5 px-1.5">
                {localImages.map((image) => (
                  <li
                    key={image.id}
                    className="flex max-w-full items-center gap-1 rounded-md border bg-muted/60 px-2 py-0.5 text-xs"
                  >
                    <span className="truncate">{image.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${image.name}`}
                      className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                      onClick={() => handleRemoveLocalImage(image.id)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
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

            {showModelControls ? <ToolsOffNotice /> : null}

            <div className="flex items-center justify-between gap-2">
              {showModelControls ? <ModelSelector withToggles variant="composer" /> : <span />}

              <div className="flex items-center gap-1">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={localImagesMode ? 'image/*' : ATTACH_ACCEPT}
                  className="sr-only"
                  onChange={(event) => void handleFilesSelected(event)}
                />

                <Tooltip>
                  <Tooltip.Content side="bottom">
                    {localImagesMode ? 'Attach a photo' : 'Attach files or images'}
                  </Tooltip.Content>
                  <Tooltip.Trigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={inputDisabled}
                      aria-label={localImagesMode ? 'Attach a photo' : 'Attach files or images'}
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
