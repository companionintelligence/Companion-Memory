import { PassThrough, Writable } from 'node:stream';

import { fixedSizeChunks, writePortabilityLine } from '../portabilityNdjson';

async function collect(source: AsyncIterable<Uint8Array>, size: number): Promise<Buffer[]> {
  const out: Buffer[] = [];

  for await (const chunk of fixedSizeChunks(source, size)) {
    out.push(chunk);
  }

  return out;
}

async function* pieces(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) {
    yield Buffer.from(part);
  }
}

describe('fixedSizeChunks', () => {
  it('re-cuts uneven pieces into chunks of the given size, the last one shorter', async () => {
    const chunks = await collect(pieces('ab', 'cdefg', 'h', 'ijklmnopq'), 4);

    expect(chunks.map((chunk) => chunk.toString())).toEqual(['abcd', 'efgh', 'ijkl', 'mnop', 'q']);
  });

  it('splits one piece longer than several chunks', async () => {
    const chunks = await collect(pieces('abcdefghij'), 3);

    expect(chunks.map((chunk) => chunk.toString())).toEqual(['abc', 'def', 'ghi', 'j']);
  });

  it('ends on a whole chunk without an empty one after it', async () => {
    const chunks = await collect(pieces('abc', 'def'), 3);

    expect(chunks.map((chunk) => chunk.toString())).toEqual(['abc', 'def']);
  });

  it('yields nothing for an empty stream', async () => {
    expect(await collect(pieces(), 3)).toEqual([]);
  });

  it('refuses a size that is not a positive whole number instead of looping forever', async () => {
    await expect(collect(pieces('abc'), 0)).rejects.toThrow(RangeError);
    await expect(collect(pieces('abc'), 1.5)).rejects.toThrow(RangeError);
  });

  it('reads the source as it goes rather than all of it first', async () => {
    let read = 0;

    async function* counted(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < 10; i += 1) {
        read += 1;
        yield Buffer.alloc(2, i);
      }
    }

    const iterator = fixedSizeChunks(counted(), 4);
    const first = await iterator.next();

    expect(first.value).toHaveLength(4);
    expect(read).toBe(2);

    await iterator.return(undefined);
  });
});

describe('writePortabilityLine', () => {
  const end = { type: 'end' as const, rows: 0, files: 0 };

  /** A stream whose buffer is always full until `drain` is emitted by hand. */
  function fullStream() {
    const lines: string[] = [];
    const out = new Writable({ write: (_chunk, _encoding, callback) => callback() });

    out.write = ((chunk: string) => {
      lines.push(chunk);

      return false;
    }) as Writable['write'];

    return { out, lines };
  }

  it('writes the record as one JSON line', async () => {
    const out = new PassThrough();
    const written: string[] = [];

    out.on('data', (chunk: Buffer) => written.push(chunk.toString()));
    await writePortabilityLine(out, end);

    expect(written.join('')).toBe('{"type":"end","rows":0,"files":0}\n');
  });

  it('waits for the stream to drain before it resolves', async () => {
    const { out, lines } = fullStream();
    let settled = false;

    const pending = writePortabilityLine(out, end).then(() => {
      settled = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(lines).toHaveLength(1);
    expect(settled).toBe(false);

    out.emit('drain');
    await pending;
    expect(settled).toBe(true);
  });

  it('rejects when the stream closes before it drains, as when the download is cancelled', async () => {
    const { out } = fullStream();

    const pending = writePortabilityLine(out, end);
    out.emit('close');

    await expect(pending).rejects.toThrow('closed before it drained');
  });

  it('refuses to write to a stream that is already destroyed', async () => {
    const out = new PassThrough();
    out.destroy();

    await expect(writePortabilityLine(out, end)).rejects.toThrow('The export stream is closed');
  });
});
