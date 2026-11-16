import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Folders a test file makes under the system temp folder, removed after each test whether it
 * passed or not. Call it once, at the top level of the file: it registers that `afterEach`.
 *
 * `timeoutMs` is the hook's budget, for a file whose fixtures take longer to remove than jest's
 * 5-second default.
 */
export function tempDirsRemovedAfterEach(timeoutMs?: number) {
  const made: string[] = [];

  afterEach(async () => {
    // Every removal starts before the first failure is reported, so one folder that will not go
    // leaves none of the others behind. The retries cover a folder something is still writing into.
    await Promise.all(
      made.splice(0).map((entry) => rm(entry, { recursive: true, force: true, maxRetries: 3 })),
    );
  }, timeoutMs);

  /** Remove `entry` after the test too, e.g. a symlink a test put beside one of its folders. */
  const removeAfterTest = (entry: string): string => {
    made.push(entry);

    return entry;
  };

  return {
    make: async (prefix: string): Promise<string> =>
      removeAfterTest(await mkdtemp(path.join(os.tmpdir(), prefix))),
    makeSync: (prefix: string): string => removeAfterTest(mkdtempSync(path.join(os.tmpdir(), prefix))),
    removeAfterTest,
  };
}
