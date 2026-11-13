import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';

import { bytes, closedPipeTolerant, csv, duration, stamp, table } from '../output';

describe('table', () => {
  it('pads columns to their widest cell and rules the header', () => {
    const rendered = table(
      [{ name: 'gpx' }, { name: 'google_photos' }],
      [{ header: 'name', value: (row) => row.name }],
    );

    expect(rendered.split('\n')).toEqual(['name', '─────────────', 'gpx', 'google_photos']);
  });

  it('right-aligns the columns that ask for it', () => {
    const rendered = table(
      [{ n: 5 }, { n: 1000 }],
      [{ header: 'n', value: (row) => String(row.n), align: 'right' }],
    );

    expect(rendered.split('\n').slice(2)).toEqual(['   5', '1000']);
  });

  it('says nothing is there in words — an empty result must not look like a failure', () => {
    expect(table([], [{ header: 'name', value: () => '' }])).toBe('(none)');
    expect(table([], [{ header: 'name', value: () => '' }], 'Nothing in the inbox.')).toBe(
      'Nothing in the inbox.',
    );
  });
});

describe('bytes', () => {
  it('scales to the unit an export is measured in', () => {
    expect(bytes(0)).toBe('0B');
    expect(bytes(1024)).toBe('1.0KB');
    expect(bytes(12 * 1024 * 1024 * 1024)).toBe('12GB');
  });

  it('is blank for an unknown size rather than 0', () => {
    expect(bytes(null)).toBe('');
    expect(bytes(undefined)).toBe('');
  });
});

describe('duration', () => {
  it('reads at a glance at every scale', () => {
    expect(duration(1500)).toBe('2s');
    expect(duration(61_000)).toBe('1m1s');
    expect(duration(3 * 3600 * 1000 + 60_000)).toBe('3h1m');
    expect(duration(null)).toBe('');
  });
});

describe('stamp', () => {
  it('trims to the minute', () => {
    expect(stamp('2026-08-16T10:30:45.123Z')).toBe('2026-08-16 10:30');
    expect(stamp(null)).toBe('');
  });
});

describe('csv', () => {
  it('trims and drops empties', () => {
    expect(csv(' a , b ,, ')).toEqual(['a', 'b']);
  });

  it('distinguishes "not given" from "given as empty"', () => {
    expect(csv(undefined)).toBeUndefined();
    expect(csv(' , ')).toBeUndefined();
  });
});

describe('closedPipeTolerant', () => {
  it.skipIf(process.platform === 'win32')(
    'drops what is left once the reader has closed the pipe, instead of crashing',
    async () => {
      // A reader that is still running but has closed its end, the way `head`
      // has once it has its ten lines. Without a listener the EPIPE below is an
      // uncaught exception, which fails this run.
      // `exec sleep` so that `kill()` below stops the sleep itself: dash forks
      // a trailing command, and killing only the shell would leave the sleep
      // holding the stdout pipe open for five seconds.
      const reader = spawn('sh', ['-c', 'exec 0<&-; echo closed; exec sleep 5'], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });

      try {
        await once(reader.stdout!, 'data');

        const stdin = reader.stdin!;
        // Not `once()`: that rejects on the very `error` event under test.
        const closed = new Promise((resolve) => stdin.once('close', resolve));
        const write = closedPipeTolerant(stdin);

        write('first line\n');
        await closed;

        expect((stdin.errored as NodeJS.ErrnoException | null)?.code).toBe('EPIPE');

        const written = vi.spyOn(stdin, 'write');

        expect(() => write('a line nobody will read\n')).not.toThrow();
        expect(written).not.toHaveBeenCalled();
      } finally {
        reader.kill();
      }
    },
  );

  // EOF is how libuv reports some broken pipes on Windows.
  it.each(['EPIPE', 'EOF'])('stops calling write after %s', (code) => {
    const stream = new PassThrough();
    const written = vi.spyOn(stream, 'write');
    const write = closedPipeTolerant(stream);

    write('before\n');
    stream.emit('error', Object.assign(new Error(`write ${code}`), { code }));
    write('after\n');

    expect(written).toHaveBeenCalledTimes(1);
    expect(written).toHaveBeenCalledWith('before\n');
  });

  it('still throws any other write error', () => {
    const stream = new PassThrough();

    closedPipeTolerant(stream);

    expect(() => stream.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO' }))).toThrow(
      'write EIO',
    );
  });
});
