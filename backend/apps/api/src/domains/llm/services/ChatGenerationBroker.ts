import { Injectable } from '@nestjs/common';
import { OnEvent as NestOnEvent } from '@nestjs/event-emitter';
import type { Response } from 'express';

import { Channel, FrameEncoder } from '@ci/common/rpc';
import { ThreadRemovedEvent, type ThreadRemovedPayload } from '@ci/domains/conversations/events';

export type ChatGenerationChunk = {
  channel: Channel;
  text: string;
};

type Listener = (event: { type: 'chunk'; chunk: ChatGenerationChunk } | { type: 'done' }) => void;

/** How often a viewer gets a keep-alive frame while the turn runs; see {@link ChatGenerationBroker.pipeToResponse}. */
export const KEEPALIVE_INTERVAL_MS = 15_000;

interface Session {
  abort: AbortController;
  text: string;
  thinking: string;
  /** Every published frame, in order, so a viewer who attaches late sees tool calls too. */
  frames: ChatGenerationChunk[];
  done: boolean;
  listeners: Set<Listener>;
}

/**
 * In-process fan-out for one chat turn. Viewers attach over HTTP; the worker
 * publishes tokens. Closing a viewer must not abort the AbortController —
 * only {@link abort} does that (explicit Stop).
 */
@Injectable()
export class ChatGenerationBroker {
  private readonly encoder = new FrameEncoder();

  private readonly sessions = new Map<string, Session>();

  private getOrCreate(threadId: string): Session {
    const existing = this.sessions.get(threadId);

    if (existing) {
      return existing;
    }

    const session: Session = {
      abort: new AbortController(),
      text: '',
      thinking: '',
      frames: [],
      done: false,
      listeners: new Set(),
    };

    this.sessions.set(threadId, session);

    return session;
  }

  ensure(threadId: string): AbortController {
    return this.getOrCreate(threadId).abort;
  }

  signal(threadId: string): AbortSignal {
    return this.ensure(threadId).signal;
  }

  has(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  snapshot(threadId: string): { text: string; thinking: string; done: boolean } {
    const session = this.sessions.get(threadId);

    return {
      text: session?.text ?? '',
      thinking: session?.thinking ?? '',
      done: session?.done ?? true,
    };
  }

  publish(threadId: string, chunk: ChatGenerationChunk): void {
    const session = this.sessions.get(threadId);

    if (session == null || session.done) {
      return;
    }

    session.frames.push(chunk);

    if (chunk.channel === Channel.TEXT) {
      session.text += chunk.text;
    } else if (chunk.channel === Channel.THINK) {
      session.thinking += chunk.text;
    }

    for (const listener of session.listeners) {
      listener({ type: 'chunk', chunk });
    }
  }

  complete(threadId: string): void {
    const session = this.sessions.get(threadId);

    if (session == null) {
      return;
    }

    session.done = true;

    for (const listener of session.listeners) {
      listener({ type: 'done' });
    }

    session.listeners.clear();
    this.sessions.delete(threadId);
  }

  abort(threadId: string): boolean {
    const session = this.sessions.get(threadId);

    if (session == null) {
      return false;
    }

    if (!session.abort.signal.aborted) {
      session.abort.abort();
    }

    session.done = true;

    for (const listener of session.listeners) {
      listener({ type: 'done' });
    }

    session.listeners.clear();

    return true;
  }

  @NestOnEvent(ThreadRemovedEvent)
  onThreadRemoved(payload: ThreadRemovedPayload): void {
    this.abort(payload.threadId);
  }

  pipeToResponse(res: Response, threadId: string): void {
    const session = this.getOrCreate(threadId);

    res.socket?.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Tells nginx — the appliance gateway, whose `/api/` location buffers by
      // default — not to hold this response back. Its `/api/llm/generate`
      // location turns buffering off by config, but `GET /llm/threads/:id/stream`
      // (re-attaching to a turn in flight) goes through the generic one, where a
      // reply would otherwise arrive in bursts when a buffer fills.
      'X-Accel-Buffering': 'no',
      'X-Thread-Id': threadId,
    });
    res.flushHeaders?.();

    // Replay the turn so far in the order it happened. Text and thinking alone
    // drop tool calls that already ran, so someone who leaves and comes back
    // mid-turn sees a reply that stops just before the lookup.
    for (const frame of session.frames) {
      res.write(Buffer.from(this.encoder.encodeFrame(frame.channel, frame.text)));
    }

    if (session.done) {
      res.end();

      return;
    }

    // Body bytes now, not at the model's first token. Cloudflare's tunnel holds the response headers
    // until the first body byte, so through a Hub's public address `fetch()` did not resolve for the
    // whole wait (109.5 s on core-7): the reply never streamed and Stop never appeared. Repeated while
    // the turn runs, so a long tool call or model load does not leave the connection idle.
    const keepAlive = () => {
      if (!res.writableEnded) {
        res.write(Buffer.from(this.encoder.encodeFrame(Channel.KEEPALIVE, '')));
      }
    };

    if (session.frames.length === 0) {
      keepAlive();
    }

    const keepAliveTimer = setInterval(keepAlive, KEEPALIVE_INTERVAL_MS);
    keepAliveTimer.unref?.();

    const listener: Listener = (event) => {
      if (res.writableEnded) {
        return;
      }

      if (event.type === 'chunk') {
        res.write(Buffer.from(this.encoder.encodeFrame(event.chunk.channel, event.chunk.text)));

        return;
      }

      clearInterval(keepAliveTimer);
      res.end();
    };

    session.listeners.add(listener);

    const detach = () => {
      clearInterval(keepAliveTimer);
      session.listeners.delete(listener);
    };

    res.on('close', detach);
    res.on('finish', detach);
  }
}
