import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { RequestContext } from '@ci/common/context';
import config from '@ci/configuration';

import { ImportPathTool } from '../ImportPathTool';

/**
 * The path-import intent's contract:
 *
 *  - refusals are RETURNED, not thrown — an agent acts on "not allowed, upload
 *    instead", where a tool error reads as a malfunction;
 *  - directories are refused and pointed at the inbox, because a directory has
 *    no single file to stage;
 *  - the staging order is copy → register → startRun, so a crash between
 *    steps leaves an unregistered staged copy (the orphan sweep's job) —
 *    never a run without bytes;
 *  - the SOURCE FILE IS NEVER TOUCHED. Paths under the roots are the user's
 *    own files; this tool copies.
 */

const ctx = { userId: 'user-1' } as RequestContext;

const roots = config.import.roots as string[];

let uploadsDir: string;
let previousUploadsDir: string;

beforeEach(async () => {
  uploadsDir = await mkdtemp(path.join(os.tmpdir(), 'ci-pathtool-uploads-'));
  previousUploadsDir = config.import.uploadsDir;
  (config.import as { uploadsDir: string }).uploadsDir = uploadsDir;
});

afterEach(() => {
  (config.import as { uploadsDir: string }).uploadsDir = previousUploadsDir;
});

async function withRoots<T>(next: string[], run: () => Promise<T>): Promise<T> {
  const previous = [...roots];

  roots.length = 0;
  roots.push(...next);

  try {
    return await run();
  } finally {
    roots.length = 0;
    roots.push(...previous);
  }
}

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

function build(role: 'admin' | 'user' = 'admin') {
  const calls: string[] = [];
  const sources = {
    registerUpload: jest.fn(async (_ctx: unknown, input: { sourcePath: string }) => {
      calls.push('register');

      // The copy must already be at its staged path when the registry hears
      // about it.
      await stat(input.sourcePath);

      return { dropId: 'drop-1' };
    }),
  };
  const runs = {
    startRun: jest.fn(async () => {
      calls.push('startRun');

      return {
        run: { id: 'run-1', label: 'export.zip' },
        stages: [{ kind: 'unpack' }, { kind: 'parse' }, { kind: 'push' }],
      };
    }),
  };
  const users = {
    findById: jest.fn(async () => ({ id: 'user-1', email: 'tester@example.com', role })),
  };
  const tool = new ImportPathTool(sources as never, runs as never, users as never, makeLogger() as never);

  return { tool, sources, runs, calls, users };
}

describe('ImportPathTool', () => {
  it('returns a refusal for a path outside the roots instead of throwing', async () => {
    const { tool, sources } = build();

    await withRoots([], async () => {
      const result = await tool.execute(ctx, { path: '/etc/passwd' });
      const data = result.data as { started: boolean; reason: string };

      expect(data.started).toBe(false);
      expect(data.reason).toBeTruthy();
      expect(sources.registerUpload).not.toHaveBeenCalled();
    });
  });

  it('refuses a directory and points at the inbox instead', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ci-pathtool-'));

    await mkdir(path.join(root, 'takeout'));

    const { tool, sources } = build();

    await withRoots([root], async () => {
      const result = await tool.execute(ctx, { path: path.join(root, 'takeout') });
      const data = result.data as { started: boolean; reason: string };

      expect(data.started).toBe(false);
      expect(data.reason).toContain('import.import_inbox');
      expect(sources.registerUpload).not.toHaveBeenCalled();
    });
  });

  it('copies into staging, registers, starts the run — and never touches the source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ci-pathtool-'));
    const file = path.join(root, 'export.zip');

    await writeFile(file, 'bytes');

    const { tool, calls } = build();

    await withRoots([root], async () => {
      const result = await tool.execute(ctx, { path: file });
      const data = result.data as { started: boolean; runId: string };

      expect(data.started).toBe(true);
      expect(data.runId).toBe('run-1');
      expect(calls).toEqual(['register', 'startRun']);

      // The user's file is still exactly where they left it...
      expect((await stat(file)).size).toBe(5);

      // ...and its staged COPY sits under <uploadsDir>/<dropId>/.
      const [dropDir] = await readdir(uploadsDir);
      const [staged] = await readdir(path.join(uploadsDir, dropDir));

      expect(await readFile(path.join(uploadsDir, dropDir, staged), 'utf8')).toBe('bytes');
    });
  });

  it('refuses a non-admin a path under a configured root, so the roots stay operator-only', async () => {
    // The configured roots are the appliance operator's surface. A household
    // member importing from them is the leak this closes — the tool threads
    // the caller's role into the resolver, which hands a non-admin only their
    // own inbox.
    const root = await mkdtemp(path.join(os.tmpdir(), 'ci-pathtool-'));
    const file = path.join(root, 'export.zip');

    await writeFile(file, 'bytes');

    const { tool, sources } = build('user');

    await withRoots([root], async () => {
      const result = await tool.execute(ctx, { path: file });
      const data = result.data as { started: boolean; reason: string };

      expect(data.started).toBe(false);
      expect(data.reason).toBeTruthy();
      expect(sources.registerUpload).not.toHaveBeenCalled();
    });
  });
});
