import {
  type ComponentProps,
  type FormEvent,
  type ReactNode,
  type RefObject,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useDeviceLayout } from '@ci/common';
import { cn } from '@ci/shadcn';
import * as smd from 'streaming-markdown';
import { type Parser as StreamingParser } from 'streaming-markdown';
import { v7 as uuid7 } from 'uuid';

import { AssistantMessage } from './blocks/AssistantMessage';
import { ThinkBlock } from './blocks/ThinkBlock';
import { ToolBlock } from './blocks/ToolBlock';
import { UserMessage } from './blocks/UserMessage';
import { ChatInput, type FormData } from './ChatInput';
import { ChatLoader } from './ChatLoader';
import { ChatMessage } from './ChatMessage';
import { useConditionalAutoscroll } from './useConditionalAutoscroll';
import { Channel, type Decoded, createStreamProcessor } from './utils';
import { VoiceMode } from './VoiceMode';

type ChatInputProps = ComponentProps<typeof ChatInput>;

interface Message {
  role: string;
  content: string;
}

interface Props extends ChatInputProps {
  autoFocus?: boolean;
  messages?: Message[];
  readable?: ReadableStream<Uint8Array>;
  emptyState?: ReactNode;
  children?: ReactNode;
  onVoiceModeToggle?: () => void;
  isVoiceModeActive?: boolean;
  companionResponse?: string;
  onResponseFinished?: (text: string) => void;
}

const textDecoder = new TextDecoder();
const supportedChannels = new Set([Channel.TEXT, Channel.THINK, Channel.TOOL]);

export function Chat({
  autoFocus = false,
  messages,
  readable,
  loading,
  streaming,
  emptyState,
  onSubmit,
  children,
  onVoiceModeToggle,
  isVoiceModeActive = false,
  companionResponse,
  onResponseFinished,
  ...chatInputProps
}: Props) {
  const autoFocusRef = useRef<HTMLTextAreaElement | null>(null);

  // We want to maintain reference to the scroll container so that we can auto-scroll
  // when we deem it appropriate. According to the contract stipulated here, that's when
  // the user is within 10 pixels of the bottom.
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const setScrollRef = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;

    if (!el) {
      return;
    }

    requestAnimationFrame(() => {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: 'instant',
      });
    });
  }, []);

  const { onScroll, maybeAutoScroll } = useConditionalAutoscroll(scrollRef, {
    threshold: 10,
  });

  // These refs are used to point to the stream target for text coming from
  // the LLM endpoint.
  const textStreamingRef = useRef<HTMLDivElement | null>(null);
  const textParserRef = useRef<StreamingParser | null>(null);

  // Track the accumulated text content for TTS
  const accumulatedTextRef = useRef<string>('');

  const setTextStreamingRef = useCallback((el: HTMLDivElement | null) => {
    textStreamingRef.current = el;

    if (!el) {
      return;
    }

    const renderer = smd.default_renderer(el);

    textParserRef.current = smd.parser(renderer);
  }, []);

  const thinkStreamingRef = useRef<HTMLDivElement | null>(null);
  const thinkParserRef = useRef<StreamingParser | null>(null);

  const setThinkStreamingRef = useCallback((el: HTMLDivElement | null) => {
    thinkStreamingRef.current = el;

    if (!el) {
      return;
    }

    const renderer = smd.default_renderer(el);

    thinkParserRef.current = smd.parser(renderer);
  }, []);

  // We want to track the channel of the last message we've received.
  // If we receive a message in a new channel we'll know to kick off
  // the clone / swap flow.
  const lastChannelRef = useRef<number | null>(null);

  const [accumulatedMessages, setAccumulatedMessages] = useState<ReactNode[]>([
    <Fragment key={uuid7()}>
      <ThinkBlock renderEmptyContent={true} defaultExpanded={true} streamingRef={setThinkStreamingRef} />
      <AssistantMessage renderEmptyContent={true} streamingRef={setTextStreamingRef} />
    </Fragment>,
  ]);

  const { isMobile } = useDeviceLayout();
  const contentPadding = useMemo(() => (isMobile ? 'p-2' : 'p-4'), [isMobile]);
  const threadPadding = useMemo(() => (isMobile ? 'pb-4 gap-2' : 'pb-4 gap-4'), [isMobile]);

  const flushStream = useCallback((node?: ReactNode) => {
    // We need to cut off the flow of streaming text to the current stream blocks.
    // We will be creating new stream blocks below to accept subsequently streamed
    // characters, but if this function has been invoked we are logically at the end
    // of a block. These refs will not be set until the next React render cycle and
    // we want to pause the text stream until they fixate on the newly created stream
    // receiver elements.
    textStreamingRef.current = null;
    textParserRef.current = null;
    thinkStreamingRef.current = null;
    thinkParserRef.current = null;

    // These are the new nodes that we'll insert into our accumulated messages.
    // When we hit the next render cycle, the refs will be set and the stream can resume.
    const newStreamNodes = (
      <Fragment key={uuid7()}>
        <ThinkBlock renderEmptyContent={true} defaultExpanded={true} streamingRef={setThinkStreamingRef} />
        <AssistantMessage renderEmptyContent={true} streamingRef={setTextStreamingRef} />
      </Fragment>
    );

    setAccumulatedMessages((prev) => (node ? [...prev, node, newStreamNodes] : [...prev, newStreamNodes]));
  }, []);

  const handleFrameChunk = useCallback(
    (chunk: Decoded) => {
      if (!supportedChannels.has(chunk.channel)) {
        console.warn('Ignored unsupported chunk channel:', chunk.channel);

        return true; // consumed → read next chunk
      }

      const lastChannel = lastChannelRef.current;
      const payload = textDecoder.decode(chunk.payload);

      lastChannelRef.current = chunk.channel;

      if (lastChannel != null && chunk.channel !== lastChannel) {
        flushStream();
      }

      if (chunk.channel === Channel.TOOL) {
        let parsed: {
          function: {
            name: string;
          };
        }[] = [];

        try {
          parsed = JSON.parse(payload) as { function: { name: string } }[];
        } catch (err) {
          console.error('Error parsing tool payload', err);
        }

        try {
          const id = uuid7();
          const toolBlocks = parsed.map((tool, i) => (
            <ToolBlock key={`${id}-${i}`} toolName={tool.function.name} />
          ));

          flushStream(toolBlocks);
        } catch (err) {
          console.error('Error inserting tool block', err);
        }

        return true;
      }

      if (chunk.channel === Channel.TEXT || chunk.channel === Channel.THINK) {
        let targetRef: RefObject<HTMLDivElement | null> = textStreamingRef;
        let parserRef: RefObject<StreamingParser | null> = textParserRef;

        if (chunk.channel === Channel.TEXT) {
          targetRef = textStreamingRef;
          parserRef = textParserRef;
        } else if (chunk.channel === Channel.THINK) {
          targetRef = thinkStreamingRef;
          parserRef = thinkParserRef;
        }

        const el = targetRef.current;

        if (el == null) {
          return false; // not ready → buffer it
        }

        const parser = parserRef.current;

        if (parser == null) {
          return false; // not ready → buffer it
        }

        smd.parser_write(parser, payload);

        // Accumulate text content for TTS (only for TEXT channel, not THINK)
        if (chunk.channel === Channel.TEXT) {
          accumulatedTextRef.current += payload;
        }

        maybeAutoScroll();
      }

      return true; // consumed → read next chunk
    },
    [flushStream],
  );

  const handleSubmit = useCallback(
    async (data: FormData, e?: FormEvent<HTMLFormElement>) => {
      const success = await onSubmit?.(data, e);

      if (success === true) {
        try {
          const block = <UserMessage key={uuid7()} content={data.message} />;

          flushStream(block);
          maybeAutoScroll(true);

          // Reset accumulated text for new response
          accumulatedTextRef.current = '';
        } catch (err) {
          console.error('Error inserting user block', err);
        }
      }

      return success;
    },
    [onSubmit, flushStream],
  );

  // Function to submit voice messages through the proper chat flow
  const submitVoiceMessage = useCallback(
    async (message: string) => {
      const formData: FormData = { message };

      return await handleSubmit(formData);
    },
    [handleSubmit],
  );

  const handleFinished = useCallback(() => {
    const lastChannel = lastChannelRef.current;

    if (lastChannel != null) {
      flushStream();
    }

    // Trigger TTS for voice mode when response is finished
    if (isVoiceModeActive && accumulatedTextRef.current.trim()) {
      console.log(
        '🎤 handleFinished: Triggering TTS with text:',
        accumulatedTextRef.current.substring(0, 100) + '...',
      );
      onResponseFinished?.(accumulatedTextRef.current);
      // Reset accumulated text for next response
      accumulatedTextRef.current = '';
    }

    const input = autoFocusRef.current;

    if (input && autoFocus) {
      requestAnimationFrame(() => {
        input.focus();
      });
    }
  }, [flushStream, autoFocus, isVoiceModeActive, onResponseFinished]);

  useEffect(() => {
    if (!readable) {
      return;
    }

    const processor = createStreamProcessor({
      stream: readable,
      onChunk: handleFrameChunk,
      onFinished: handleFinished,
    });

    processor.start();

    return () => {
      processor.cancel();
    };
  }, [readable, handleFinished, handleFrameChunk]);

  useEffect(() => {
    const el = scrollRef.current;

    if (el) {
      requestAnimationFrame(() => {
        el.scrollTo({
          top: el.scrollHeight,
          behavior: 'instant',
        });
      });
    }
  }, [messages]);

  useEffect(() => {
    maybeAutoScroll();
  }, [accumulatedMessages]);

  const renderedMessages = useMemo(
    () => messages?.map((message, i) => <ChatMessage key={i} {...message} />),
    [messages],
  );

  return (
    <div className="flex flex-col h-full min-h-0 w-full relative">
      {children == null && (messages?.length ?? 0) === 0 && accumulatedMessages.length === 1 && (
        <div className="flex flex-col flex-1 min-h-0 p-4 items-center justify-center">{emptyState}</div>
      )}

      {(children != null || (messages?.length ?? 0) > 0 || accumulatedMessages.length > 1) && (
        <div
          ref={setScrollRef}
          onScroll={onScroll}
          className={cn(
            'flex flex-col gap-4 flex-1 min-h-0 overflow-y-scroll',
            contentPadding,
            threadPadding,
            '[mask-image:linear-gradient(to_top,transparent,hsl(0_0%_100%)_1rem)]',
            '[mask-repeat:no-repeat] [mask-size:100%_100%]',
            '[-webkit-mask-image:linear-gradient(to_top,transparent,hsl(0_0%_100%)_1rem)]',
            '[-webkit-mask-repeat:no-repeat] [-webkit-mask-size:100%_100%]',
          )}
        >
          {children}
          {renderedMessages}
          {accumulatedMessages}
        </div>
      )}

      <div className={cn('w-full relative', contentPadding)}>
        {(loading || streaming) && <ChatLoader />}

        <VoiceMode
          isActive={isVoiceModeActive}
          onToggle={onVoiceModeToggle || (() => {})}
          onSubmitMessage={submitVoiceMessage}
          companionResponse={companionResponse}
        />

        <ChatInput
          ref={autoFocusRef}
          loading={loading}
          streaming={streaming}
          onSubmit={handleSubmit}
          onVoiceModeToggle={onVoiceModeToggle}
          isVoiceModeActive={isVoiceModeActive}
          {...chatInputProps}
        />
      </div>
    </div>
  );
}
