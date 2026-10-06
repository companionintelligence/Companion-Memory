import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { RequestContext } from '@ci/common/context';
import config from '@ci/configuration';

import { ImportRecognizePathTool } from '../ImportRecognizePathTool';

/**
 * The recognize intent reads the configured import roots only for the
 * appliance administrator. On a desktop install those roots are a mount of the
 * owner's Downloads folder, so the caller's role, not just a signed-in session,
 * decides whether a path there is answered.
 */

const ctx = { userId: 'user-1' } as RequestContext;

const roots = config.import.roots as string[];

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

function build(role: 'admin' | 'user') {
  const users = {
    findById: jest.fn(async () => ({ id: 'user-1', email: 'tester@example.com', role })),
  };
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };

  return new ImportRecognizePathTool(users as never, logger as never);
}

describe('ImportRecognizePathTool', () => {
  it('answers the administrator for a path under a configured root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ci-recognize-tool-'));
    const file = path.join(root, 'export.zip');
    await writeFile(file, 'bytes');

    await withRoots([root], async () => {
      const result = await build('admin').execute(ctx, { path: file });

      expect((result.data as { allowed: boolean }).allowed).toBe(true);
    });
  });

  it('refuses a non-admin the same path, without naming the configured roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ci-recognize-tool-'));
    const file = path.join(root, 'export.zip');
    await writeFile(file, 'bytes');

    await withRoots([root], async () => {
      const result = await build('user').execute(ctx, { path: file });
      const data = result.data as { allowed: boolean; reason: string; recognized: unknown[] };

      expect(data.allowed).toBe(false);
      expect(data.recognized).toEqual([]);
      // The refusal lists the roots this caller may use: their own inbox only.
      expect(data.reason.slice(data.reason.lastIndexOf('('))).not.toContain(root);
    });
  });
});
