import { type ForwardedRef, type RefObject, forwardRef, useMemo } from 'react';

import { cn, Button, Tooltip } from '@ci/shadcn';
import { Bot, Volume2 } from '@ci/shadcn/icons';

import { TextBlock } from '../../ChatBlocks/TextBlock';

interface Props {
  content?: string;
  renderEmptyContent?: boolean;
  streamingRef?: RefObject<HTMLDivElement | null> | ((el: HTMLDivElement | null) => void);
}

function AssistantMessage(
  { content, renderEmptyContent = false, streamingRef }: Props,
  ref: ForwardedRef<HTMLDivElement>,
) {
  const trimmedContent = useMemo(() => content?.trim(), [content]);

  if (!trimmedContent && !renderEmptyContent) {
    return null;
  }

  return (
    <div
      ref={ref}
      className={cn(
        'relative rounded-xl rounded-tl-none px-4 py-3 text-sm shadow-sm bg-gradient-to-br from-muted to-muted/80 text-foreground border border-border/50 backdrop-blur-sm group',
        'has-[>.streaming-content:empty]:hidden',
      )}
    >
      <div className="streaming-content" ref={streamingRef}>
        {trimmedContent ? <TextBlock content={trimmedContent} /> : null}
      </div>

      {/* TTS Button - appears on hover */}
      {trimmedContent && (
        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <Tooltip>
            <Tooltip.Content side="bottom">Speak message</Tooltip.Content>
            <Tooltip.Trigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={false}
                className="h-6 w-6 p-0"
                onClick={async () => {
                  if (!trimmedContent) {
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
                            content: trimmedContent,
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
        </div>
      )}

      <div className="absolute -top-2 -left-2 p-1 rounded-full bg-gradient-to-br from-gray-400 to-gray-400">
        <Bot className="h-4 w-4 text-primary-foreground z-10" />
      </div>
    </div>
  );
}

const AssistantMessageRef = forwardRef<HTMLDivElement, Props>(AssistantMessage);

export { AssistantMessageRef as AssistantMessage };
