import {
  type BaseSyntheticEvent,
  type FormEvent,
  type ForwardedRef,
  type KeyboardEvent,
  type MouseEvent,
  forwardRef,
  useCallback,
} from 'react';

import { VoiceInput } from '@ci/capture';
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
import { Send, Square, Plus, Volume2 } from '@ci/shadcn/icons';

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
  lastAssistantMessage?: string;
  onAttach?: (e: MouseEvent<HTMLButtonElement>) => void | Promise<void>;
  //onRecord?: (e: MouseEvent<HTMLButtonElement>) => void | Promise<void>;
  onStop?: (e: MouseEvent<HTMLButtonElement>) => void | Promise<void>;
  onSubmit?: (data: FormData, e?: FormEvent<HTMLFormElement>) => boolean | void | Promise<boolean | void>;
}

function ChatInput(
  {
    disabled = false,
    loading = false,
    streaming = false,
    placeholder,
    lastAssistantMessage,
    onAttach,
    //onRecord,
    onSubmit,
    onStop,
  }: Props,
  forwardedRef: ForwardedRef<HTMLTextAreaElement>,
) {
  const SendIcon = streaming ? Square : Send;
  const sendIconClassName = streaming ? '' : 'left-[-0.5px] top-[0.5px]';

  const form = useForm<FormData>({
    resolver: formDataResolver(FormSchema),
    defaultValues: EMPTY,
  });

  const handleAttach = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      onAttach?.(e);
    },
    [onAttach],
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

  // Handle voice transcription
  const handleVoiceTranscription = useCallback(
    (text: string) => {
      form.setValue('message', text);
    },
    [form],
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
                <Tooltip.Content side="bottom">Voice input</Tooltip.Content>
                <Tooltip.Trigger asChild>
                  <div className="flex items-center">
                    <VoiceInput
                      onTranscription={handleVoiceTranscription}
                      disabled={loading || disabled}
                      className="p-0"
                      voiceServiceUrl="/stt/transcribe"
                    />
                  </div>
                </Tooltip.Trigger>
              </Tooltip>

              <Tooltip>
                <Tooltip.Content side="bottom">Speak message</Tooltip.Content>
                <Tooltip.Trigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loading || streaming || disabled || !form.watch('message')?.trim()}
                    className="h-8 w-8 p-0"
                    onClick={async () => {
                      const messageText = form.watch('message') || '';
                      if (!messageText.trim()) {
                        return;
                      }

                      try {
                        const response = await fetch('/tts/v1/chat/completions', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            model: 'higgs-audio-v2-generation-3B-base',
                            messages: [
                              {
                                role: 'user',
                                content: messageText.trim(),
                              },
                            ],
                            max_tokens: 2048,
                          }),
                        });

                        if (response.ok) {
                          const result = await response.json();

                          // Extract audio data from Higgs Audio vLLM response
                          if (result.choices && result.choices.length > 0) {
                            const choice = result.choices[0];
                            if (choice.message && choice.message.audio && choice.message.audio.data) {
                              const audioData = choice.message.audio.data;

                              // Convert base64 to audio blob
                              const binaryString = atob(audioData);
                              const bytes = new Uint8Array(binaryString.length);
                              for (let i = 0; i < binaryString.length; i++) {
                                bytes[i] = binaryString.charCodeAt(i);
                              }

                              console.log('Audio data length:', bytes.length);

                              // Use MP3 format for better browser compatibility
                              const audioBlob = new Blob([bytes], { type: 'audio/mpeg' });
                              const audioUrl = URL.createObjectURL(audioBlob);

                              // Create and play audio using HTML5 Audio element
                              const audio = new Audio(audioUrl);

                              audio.onended = () => {
                                URL.revokeObjectURL(audioUrl);
                              };

                              audio.onerror = (e) => {
                                console.error('Audio playback error:', e);
                                URL.revokeObjectURL(audioUrl);
                              };

                              await audio.play();
                              console.log('Audio playback started');
                            }
                          }
                        }
                      } catch (error) {
                        console.error('TTS error:', error);
                      }
                    }}
                  >
                    <Volume2 className="h-4 w-4" />
                  </Button>
                </Tooltip.Trigger>
              </Tooltip>

              {lastAssistantMessage && (
                <Tooltip>
                  <Tooltip.Content side="bottom">Speak assistant response</Tooltip.Content>
                  <Tooltip.Trigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={loading || disabled}
                      className="h-8 w-8 p-0"
                      onClick={async () => {
                        try {
                          const response = await fetch('/tts/v1/chat/completions', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              model: 'higgs-audio-v2-generation-3B-base',
                              messages: [
                                {
                                  role: 'user',
                                  content: lastAssistantMessage,
                                },
                              ],
                              max_tokens: 2048,
                            }),
                          });

                          if (response.ok) {
                            const result = await response.json();

                            // Extract audio data from Higgs Audio vLLM response
                            if (result.choices && result.choices.length > 0) {
                              const choice = result.choices[0];
                              if (choice.message && choice.message.audio && choice.message.audio.data) {
                                const audioData = choice.message.audio.data;

                                // Convert base64 to audio blob
                                const binaryString = atob(audioData);
                                const bytes = new Uint8Array(binaryString.length);
                                for (let i = 0; i < binaryString.length; i++) {
                                  bytes[i] = binaryString.charCodeAt(i);
                                }

                                console.log('Audio data length:', bytes.length);

                                // Use MP3 format for better browser compatibility
                                const audioBlob = new Blob([bytes], { type: 'audio/mpeg' });
                                const audioUrl = URL.createObjectURL(audioBlob);
                                const audio = new Audio(audioUrl);

                                audio.onended = () => {
                                  URL.revokeObjectURL(audioUrl);
                                };

                                audio.onerror = (e) => {
                                  console.error('Audio playback error:', e);
                                  URL.revokeObjectURL(audioUrl);
                                };

                                await audio.play();
                                console.log('Audio playback started');
                              }
                            }
                          }
                        } catch (error) {
                          console.error('TTS error:', error);
                        }
                      }}
                    >
                      <Volume2 className="h-4 w-4" />
                    </Button>
                  </Tooltip.Trigger>
                </Tooltip>
              )}

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
