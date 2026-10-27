import { Channel } from '@ci/common/rpc';

import { ChatGenerationBroker, KEEPALIVE_INTERVAL_MS } from '../ChatGenerationBroker';

/** The channel of each whole frame in `raw` (`[channel<<6|flags][UInt32 BE length][payload]`). */
function frameChannels(raw: Buffer): number[] {
  const channels: number[] = [];

  for (let offset = 0; offset + 5 <= raw.length; offset += 5 + raw.readUInt32BE(offset + 1)) {
    channels.push(raw[offset] >> 6);
  }

  return channels;
}

function mockResponse() {
  const chunks: Buffer[] = [];
  let ended = false;
  const closeHandlers: Array<() => void> = [];

  const res = {
    socket: { setNoDelay: jest.fn() },
    writeHead: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn((buf: Buffer) => {
      chunks.push(Buffer.from(buf));
    }),
    end: jest.fn(() => {
      ended = true;
    }),
    on: jest.fn((event: string, handler: () => void) => {
      if (event === 'close') {
        closeHandlers.push(handler);
      }
    }),
    get writableEnded() {
      return ended;
    },
  };

  return { res, chunks, closeHandlers, isEnded: () => ended };
}

describe('ChatGenerationBroker', () => {
  // The appliance gateway's generic `/api/` location buffers a proxied response
  // by default, which turns a token stream into bursts. `/api/llm/generate` is
  // unbuffered by config, but re-attaching to a turn in flight
  // (`GET /llm/threads/:id/stream`) is not — the response has to say so itself.
  it('tells a buffering proxy to pass the stream through, and exposes the thread id', () => {
    const broker = new ChatGenerationBroker();
    const { res } = mockResponse();

    broker.pipeToResponse(res as never, 'thread-1');

    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        'Content-Type': 'text/event-stream',
        'X-Accel-Buffering': 'no',
        'X-Thread-Id': 'thread-1',
      }),
    );
    expect(res.flushHeaders).toHaveBeenCalled();
  });

  // Cloudflare's tunnel holds the response headers until the first body byte. With no body until
  // the model's first token, a reply through a Hub's public address neither streamed nor could be
  // stopped: `fetch()` resolved only when the whole wait was over.
  it('writes a keep-alive frame as soon as a viewer attaches to a turn with nothing to replay', () => {
    const broker = new ChatGenerationBroker();
    broker.ensure('thread-1');
    const { res, chunks } = mockResponse();

    broker.pipeToResponse(res as never, 'thread-1');

    expect(frameChannels(Buffer.concat(chunks))).toEqual([Channel.KEEPALIVE]);
  });

  it('repeats the keep-alive while the model is quiet, and stops once the turn ends', () => {
    jest.useFakeTimers();

    try {
      const broker = new ChatGenerationBroker();
      broker.ensure('thread-1');
      const { res, chunks } = mockResponse();

      broker.pipeToResponse(res as never, 'thread-1');
      jest.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * 2);
      broker.publish('thread-1', { channel: Channel.TEXT, text: 'Hi' });
      broker.complete('thread-1');
      jest.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * 3);

      expect(frameChannels(Buffer.concat(chunks))).toEqual([
        Channel.KEEPALIVE,
        Channel.KEEPALIVE,
        Channel.KEEPALIVE,
        Channel.TEXT,
      ]);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops the keep-alive when the viewer goes away', () => {
    jest.useFakeTimers();

    try {
      const broker = new ChatGenerationBroker();
      broker.ensure('thread-1');
      const { res, closeHandlers } = mockResponse();

      broker.pipeToResponse(res as never, 'thread-1');
      closeHandlers.forEach((handler) => handler());

      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not abort the generation signal when an HTTP viewer disconnects', () => {
    const broker = new ChatGenerationBroker();
    const signal = broker.signal('thread-1');
    const { res, closeHandlers } = mockResponse();

    broker.pipeToResponse(res as never, 'thread-1');
    closeHandlers.forEach((handler) => handler());

    expect(signal.aborted).toBe(false);
  });

  it('ends attached viewers on abort without deleting the worker signal', () => {
    const broker = new ChatGenerationBroker();
    const signal = broker.signal('thread-1');
    const { res } = mockResponse();

    broker.pipeToResponse(res as never, 'thread-1');
    broker.abort('thread-1');

    expect(signal.aborted).toBe(true);
    expect(res.end).toHaveBeenCalled();
    expect(broker.has('thread-1')).toBe(true);
  });

  it('replays snapshot then live chunks to a late viewer', () => {
    const broker = new ChatGenerationBroker();
    broker.ensure('thread-1');
    broker.publish('thread-1', { channel: Channel.TEXT, text: 'Hel' });

    const { res, chunks } = mockResponse();
    broker.pipeToResponse(res as never, 'thread-1');

    expect(chunks.length).toBeGreaterThan(0);

    broker.publish('thread-1', { channel: Channel.TEXT, text: 'lo' });
    broker.complete('thread-1');

    expect(res.end).toHaveBeenCalled();
  });

  it('replays tool calls that already happened to a viewer who attaches late', () => {
    const broker = new ChatGenerationBroker();
    broker.ensure('thread-1');
    broker.publish('thread-1', { channel: Channel.TEXT, text: 'Let me look.' });
    broker.publish('thread-1', {
      channel: Channel.TOOL,
      text: JSON.stringify([{ function: { name: 'places_find' } }]),
    });

    const { res, chunks } = mockResponse();
    broker.pipeToResponse(res as never, 'thread-1');

    const raw = Buffer.concat(chunks).toString('utf8');

    expect(raw).toContain('Let me look.');
    expect(raw.indexOf('Let me look.')).toBeLessThan(raw.indexOf('places_find'));
    // The replay is the first body byte already, so no keep-alive goes ahead of it.
    expect(frameChannels(Buffer.concat(chunks))).toEqual([Channel.TEXT, Channel.TOOL]);
  });
});
