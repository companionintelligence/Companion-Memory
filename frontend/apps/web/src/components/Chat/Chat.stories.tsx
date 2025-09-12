import { Buffer } from 'buffer';

import { type ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { Chat } from './Chat';
import { Channel, FrameEncoder } from './utils';

type Props = ComponentProps<typeof Chat>;

const meta: Meta<Props> = {
  component: Chat,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    onStop: fn(),
    onSubmit: fn(() => Promise.resolve(true)),
  },
  decorators: [
    (Story) => (
      <div className="h-lvh overflow-hidden">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<Props>;

const frameEncoder = new FrameEncoder();

function makeByteChannel() {
  let controller: ReadableStreamDefaultController<Uint8Array>;

  const readable = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
    },
  });

  const write = (chunk: Buffer | Uint8Array) => {
    if (controller) {
      controller.enqueue(new Uint8Array(chunk));
    } else {
      console.warn('Attempted to write to a channel before it was ready.');
    }
  };

  const close = () => {
    if (controller) {
      controller.close();
    }
  };

  const error = (err: Error) => {
    if (controller) {
      controller.error(err);
    }
  };

  return { readable, write, close, error };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new DOMException('Aborted', 'AbortError'));
    }

    const timeoutId = setTimeout(resolve, ms);

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeoutId);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

export const Default: Story = {
  args: {
    messages: [
      {
        role: 'user',
        content:
          'Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n\nSed dignissim at nibh eget viverra.\n\nFusce sed mi risus. Nullam ut sem sit amet turpis lacinia laoreet non non erat. Suspendisse viverra, magna accursus volutpat, tellus ipsum finibus eros, a commodo purus erat a neque. Etiam eget egestas orci.',
      },
      {
        role: 'tool',
        content: 'Foobar',
      },
      {
        role: 'assistant',
        content:
          'Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n\nSed dignissim at nibh eget viverra.\n\nFusce sed mi risus. Nullam ut sem sit amet turpis lacinia laoreet non non erat. Suspendisse viverra, magna accursus volutpat, tellus ipsum finibus eros, a commodo purus erat a neque. Etiam eget egestas orci.',
      },
      {
        role: 'user',
        content:
          'Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n\nSed dignissim at nibh eget viverra.\n\nFusce sed mi risus. Nullam ut sem sit amet turpis lacinia laoreet non non erat. Suspendisse viverra, magna accursus volutpat, tellus ipsum finibus eros, a commodo purus erat a neque. Etiam eget egestas orci.',
      },
      {
        role: 'assistant',
        content:
          '<think>I am a helpful assistant, I can see what the user might be thinking. Hmmm... what lorem text to generate to help?</think>Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n\nSed dignissim at nibh eget viverra.\n\nFusce sed mi risus. Nullam ut sem sit amet turpis lacinia laoreet non non erat. Suspendisse viverra, magna accursus volutpat, tellus ipsum finibus eros, a commodo purus erat a neque. Etiam eget egestas orci.',
      },
    ],
    loading: false,
  },
};

export const WithoutChildren: Story = {
  args: {},
};

export const StreamingText: Story = {
  decorators: [
    (Story, ctx) => {
      const abortControllerRef = useRef<AbortController | null>(null);
      const channel = useMemo(() => makeByteChannel(), []);
      const [streaming, setStreaming] = useState(true);

      async function* scriptedChunks(signal: AbortSignal) {
        const thinking = `Hmm... let me piece this together. I'm considering how the structure flows, and whether the sequence of tokens aligns with the intended pattern. It looks like there are multiple possible branches here, but one seems more consistent. If I break this down step by step, I should be able to maintain coherence. I might need to reconcile a few edge cases, but overall the direction seems clear. I'll refine the output so it's both logical and natural. Yes, I think this is the right path forward.`;

        for (const ch of thinking) {
          yield frameEncoder.encodeFrame(Channel.THINK, ch);
          await sleep(Math.floor(Math.random() * 5) + 5, signal);
        }

        await sleep(500, signal);

        yield frameEncoder.encodeFrame(
          Channel.TOOL,
          JSON.stringify([
            {
              function: {
                name: 'fetchTimeAwareness',
              },
            },
          ]),
        );

        await sleep(1500, signal);

        yield frameEncoder.encodeFrame(
          Channel.TOOL,
          JSON.stringify([
            {
              function: {
                name: 'recombobulateBearings',
              },
            },
          ]),
        );

        await sleep(1500, signal);

        for (let i = 0; i < 100; i++) {
          yield frameEncoder.encodeFrame(Channel.TEXT, `line ${i} — ${new Date().toLocaleTimeString()}\n`);
          await sleep(50, signal);
        }
      }

      const handleStop = useCallback(() => {
        abortControllerRef.current?.abort();
      }, []);

      useEffect(() => {
        const controller = new AbortController();

        abortControllerRef.current = controller;
        setStreaming(true);

        const runStream = async () => {
          try {
            for await (const chunk of scriptedChunks(controller.signal)) {
              if (controller.signal.aborted) {
                break;
              }

              channel.write(Buffer.from(chunk));
            }
          } catch (error) {
            if ((error as Error).name !== 'AbortError') {
              console.error('Stream encountered an unhandled error', error);
              channel.error(error as Error);
            }
          } finally {
            channel.close();
            setStreaming(false);
          }
        };

        runStream();

        return () => {
          controller.abort();
        };
      }, [channel]);

      return (
        <Story
          args={{
            ...ctx.args,
            readable: channel.readable,
            streaming,
            onStop: handleStop,
          }}
        />
      );
    },
  ],
  args: {
    messages: [
      {
        role: 'user',
        content: 'May you please generate some text content in the format:\n\nline # — H:MM:SS',
      },
    ],
  },
};
