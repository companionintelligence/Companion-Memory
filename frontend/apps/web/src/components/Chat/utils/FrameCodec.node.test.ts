import { describe, expect, it } from 'vitest';

import { FrameDecoder } from './FrameDecoder';
import { FrameEncoder } from './FrameEncoder';
import { Channel, Flag } from './types';

const text = (payload: Uint8Array) => new TextDecoder().decode(payload);

function concat(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  return out;
}

describe('FrameEncoder / FrameDecoder round-trip', () => {
  it('encodes and decodes a single frame', () => {
    const frame = new FrameEncoder().encodeFrame(Channel.TEXT, 'hello');
    const decoded = new FrameDecoder().push(frame);

    expect(decoded).toHaveLength(1);
    expect(decoded[0].channel).toBe(Channel.TEXT);
    expect(decoded[0].flags).toBe(0);
    expect(text(decoded[0].payload)).toBe('hello');
  });

  it('packs the channel into the high 2 header bits', () => {
    const frame = new FrameEncoder().encodeFrame(Channel.THINK, 'x');

    expect(frame[0]).toBe((1 << 6) | 0);
    expect(new FrameDecoder().push(frame)[0].channel).toBe(Channel.THINK);
  });

  it('packs flags into the low 6 header bits', () => {
    const frame = new FrameEncoder().encodeFrame(Channel.TOOL, 'x', Flag.START | Flag.END);

    expect(frame[0]).toBe((2 << 6) | 3);

    const decoded = new FrameDecoder().push(frame)[0];
    expect(decoded.channel).toBe(Channel.TOOL);
    expect(decoded.flags).toBe(Flag.START | Flag.END);
  });

  it('preserves multi-byte UTF-8 payloads (big-endian length)', () => {
    const message = 'héllo 🌍 world';
    const frame = new FrameEncoder().encodeFrame(Channel.TEXT, message);
    const decoded = new FrameDecoder().push(frame)[0];

    expect(text(decoded.payload)).toBe(message);
  });

  it('decodes several frames concatenated into one chunk', () => {
    const enc = new FrameEncoder();
    const buffer = concat(enc.encodeFrame(Channel.TEXT, 'one'), enc.encodeFrame(Channel.THINK, 'two'));

    const decoded = new FrameDecoder().push(buffer);

    expect(decoded.map((d) => text(d.payload))).toEqual(['one', 'two']);
    expect(decoded.map((d) => d.channel)).toEqual([Channel.TEXT, Channel.THINK]);
  });

  it('reassembles a frame split across chunk boundaries', () => {
    const frame = new FrameEncoder().encodeFrame(Channel.TEXT, 'streamed');
    const decoder = new FrameDecoder();

    // Header arrives, but not the full payload yet.
    expect(decoder.push(frame.slice(0, 6))).toEqual([]);
    expect(decoder.hasBufferedData()).toBe(true);

    const decoded = decoder.push(frame.slice(6));
    expect(decoded).toHaveLength(1);
    expect(text(decoded[0].payload)).toBe('streamed');
    expect(decoder.hasBufferedData()).toBe(false);
  });

  it('buffers a partial header until more bytes arrive', () => {
    const frame = new FrameEncoder().encodeFrame(Channel.TEXT, 'hi');
    const decoder = new FrameDecoder();

    expect(decoder.push(frame.slice(0, 3))).toEqual([]); // < 5 header bytes
    expect(decoder.hasBufferedData()).toBe(true);
    expect(text(decoder.push(frame.slice(3))[0].payload)).toBe('hi');
  });
});
