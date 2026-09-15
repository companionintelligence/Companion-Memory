/**
 * The "vips binary is not installed" path, in its own file because it mocks
 * `node:child_process` for the whole module — jest.mock is file-scoped via
 * hoisting, so sharing a file with VipsService.test.ts's real-decode suites
 * would mock the OS call out from under them too.
 *
 * This started as a `process.env.PATH = '/nonexistent-dir'` test relying on
 * the OS to genuinely fail the lookup. That is NOT reliable under Jest: a
 * bare `promisify(execFile)('vipsheader', ...)` with PATH stubbed out still
 * resolved the real binary in this suite, though the identical mutation
 * behaves correctly in a plain Node script — some part of the Jest/Node
 * worker setup does not thread a mutated `process.env.PATH` through to
 * libuv's spawn-time search. Mocking `execFile` directly tests the same
 * ENOENT branch deterministically, independent of that.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

jest.mock('node:child_process', () => ({
  execFile: jest.fn((_cmd: string, _args: string[], _opts: unknown, callback: (err: unknown) => void) => {
    callback(Object.assign(new Error('spawn vips ENOENT'), { code: 'ENOENT' }));
  }),
}));

import { VipsDecodeError, VipsService, VipsUnavailableError } from '../VipsService';

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name));

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describe('VipsService when the tools are missing', () => {
  it('throws VipsUnavailableError (not VipsDecodeError) on an ENOENT from the OS', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new VipsService(makeLogger() as any);

    await expect(service.probe(fixture('64x40.jpg'))).rejects.toBeInstanceOf(VipsUnavailableError);
    await expect(service.probe(fixture('64x40.jpg'))).rejects.not.toBeInstanceOf(VipsDecodeError);
  });
});
