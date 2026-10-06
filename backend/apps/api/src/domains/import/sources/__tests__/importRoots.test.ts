import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import config from '@ci/configuration';

import {
  PathOutsideImportRootsError,
  realUserInboxDir,
  resolveWithinImportRoots,
  resolveWithinRoots,
  resolveWithinUserInbox,
  userInboxDir,
  userInboxDisplayDir,
} from '../importRoots';

/**
 * The guard on the path-based import tools.
 *
 * Upstream never needed one: the importer ran on the user's own machine as the
 * user. Here it is an API on an appliance, so an unconstrained absolute path is
 * a filesystem read primitive — a caller could enumerate `/etc`, or ingest it.
 *
 * Every case below is a way past a naive check, and each one has to fail closed.
 */

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

async function withInbox<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const previous = config.import.inboxDir;

  (config.import as { inboxDir: string }).inboxDir = dir;

  try {
    return await run();
  } finally {
    (config.import as { inboxDir: string }).inboxDir = previous;
  }
}

const OWNER = '00000000-0000-7000-8000-000000000001';
const MEMBER = '00000000-0000-7000-8000-000000000002';

/** A signed-in caller who is the appliance administrator. */
const admin = (userId: string | null = null): { userId: string | null; isAdmin: boolean } => ({
  userId,
  isAdmin: true,
});

/** A signed-in caller who is not — a household member, or a plain api key. */
const member = (userId: string | null = null): { userId: string | null; isAdmin: boolean } => ({
  userId,
  isAdmin: false,
});

describe('resolveWithinImportRoots', () => {
  it('refuses everything when no roots are configured, even for an admin', async () => {
    // The default. Path imports stay off until an operator opts in, rather than
    // being on and hoping the check is right.
    await withRoots([], async () => {
      await expect(resolveWithinImportRoots('/etc/passwd', admin())).rejects.toBeInstanceOf(
        PathOutsideImportRootsError,
      );
    });
  });

  it('lets the administrator reach a configured root but refuses a non-admin there', async () => {
    // The configured roots are the appliance operator's surface — on a desktop
    // install `/repo` is a mount of the owner's ~/Downloads. A household member
    // used to reach them too; now only the administrator does.
    const root = await mkdtemp(path.join(os.tmpdir(), 'ci-roots-'));
    const file = path.join(root, 'export.zip');

    await writeFile(file, 'bytes');

    await withRoots([root], async () => {
      expect(await resolveWithinImportRoots(file, admin())).toContain('export.zip');
      await expect(resolveWithinImportRoots(file, member())).rejects.toBeInstanceOf(
        PathOutsideImportRootsError,
      );
    });
  });

  it('refuses a traversal out of the root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ci-roots-'));

    await withRoots([root], async () => {
      await expect(
        resolveWithinImportRoots(path.join(root, '..', '..', 'etc', 'passwd'), admin()),
      ).rejects.toBeInstanceOf(PathOutsideImportRootsError);
    });
  });

  it('refuses a sibling whose name merely starts with the root', async () => {
    // `/srv/exports-secret` must not pass because `/srv/exports` is a string
    // prefix of it. This is why containment compares path segments.
    const parent = await mkdtemp(path.join(os.tmpdir(), 'ci-roots-'));
    const root = path.join(parent, 'exports');
    const sibling = path.join(parent, 'exports-secret');

    await mkdir(root);
    await mkdir(sibling);
    await writeFile(path.join(sibling, 'secret.zip'), 'bytes');

    await withRoots([root], async () => {
      await expect(
        resolveWithinImportRoots(path.join(sibling, 'secret.zip'), admin()),
      ).rejects.toBeInstanceOf(PathOutsideImportRootsError);
    });
  });

  it('refuses a symlink inside the root that points outside it', async () => {
    // The bypass a naive check misses: the literal path is contained, and only
    // following the link reveals where it actually leads. Hence realpath BEFORE
    // the containment test.
    const parent = await mkdtemp(path.join(os.tmpdir(), 'ci-roots-'));
    const root = path.join(parent, 'exports');
    const outside = path.join(parent, 'elsewhere');

    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.zip'), 'bytes');
    await symlink(path.join(outside, 'secret.zip'), path.join(root, 'link.zip'));

    await withRoots([root], async () => {
      await expect(resolveWithinImportRoots(path.join(root, 'link.zip'), admin())).rejects.toBeInstanceOf(
        PathOutsideImportRootsError,
      );
    });
  });

  it('reports a path that does not exist as out of bounds, not as missing', async () => {
    // "Does this file exist?" is information about a filesystem the caller has
    // no business reading, so absence and refusal answer identically.
    const root = await mkdtemp(path.join(os.tmpdir(), 'ci-roots-'));

    await withRoots([root], async () => {
      await expect(resolveWithinImportRoots(path.join(root, 'nope.zip'), admin())).rejects.toBeInstanceOf(
        PathOutsideImportRootsError,
      );
    });
  });

  it("allows the caller's own inbox subtree — admin or not — and only theirs", async () => {
    // The per-user inbox is each caller's own slice of the shared mount and is
    // on for everyone, independent of the operator's roots and of role. Another
    // account's slice, the shared root, and an anonymous caller get nothing.
    const inbox = await mkdtemp(path.join(os.tmpdir(), 'ci-inbox-'));

    await mkdir(path.join(inbox, OWNER));
    await mkdir(path.join(inbox, MEMBER));

    const mine = path.join(inbox, OWNER, 'export.zip');
    const theirs = path.join(inbox, MEMBER, 'export.zip');
    const shared = path.join(inbox, 'export.zip');

    await writeFile(mine, 'bytes');
    await writeFile(theirs, 'bytes');
    await writeFile(shared, 'bytes');

    await withRoots([], () =>
      withInbox(inbox, async () => {
        expect(await resolveWithinImportRoots(mine, member(OWNER))).toContain('export.zip');

        for (const refused of [theirs, shared]) {
          await expect(resolveWithinImportRoots(refused, member(OWNER))).rejects.toBeInstanceOf(
            PathOutsideImportRootsError,
          );
        }

        await expect(resolveWithinImportRoots(mine, member(null))).rejects.toBeInstanceOf(
          PathOutsideImportRootsError,
        );
      }),
    );
  });

  it('still contains paths when a configured root does not exist', async () => {
    // An unmounted /repo must contribute nothing — not break resolution for
    // the roots that do exist, and not let anything through.
    const root = await mkdtemp(path.join(os.tmpdir(), 'ci-roots-'));
    const file = path.join(root, 'export.zip');

    await writeFile(file, 'bytes');

    await withRoots(['/does/not/exist', root], async () => {
      expect(await resolveWithinImportRoots(file, admin())).toContain('export.zip');
      await expect(resolveWithinImportRoots('/etc/passwd', admin())).rejects.toBeInstanceOf(
        PathOutsideImportRootsError,
      );
    });
  });
});

async function withInboxHostDir<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const previous = config.import.inboxHostDir;

  (config.import as { inboxHostDir: string }).inboxHostDir = dir;

  try {
    return await run();
  } finally {
    (config.import as { inboxHostDir: string }).inboxHostDir = previous;
  }
}

describe('resolveWithinUserInbox', () => {
  it('keys the user folder on the account id, not the email', async () => {
    // Two addresses that sanitize to one folder name used to share an inbox;
    // the immutable account id cannot collide, so each account is its own.
    const inbox = await mkdtemp(path.join(os.tmpdir(), 'ci-inbox-'));

    await withInbox(inbox, async () => {
      expect(userInboxDir(OWNER)).toBe(path.join(inbox, OWNER));
    });
  });
});

describe('userInboxDisplayDir', () => {
  /**
   * What the scan SHOWS. The API's own path is inside the container; the
   * person dropping files is on the host, where the same folder is the bind
   * mount's source. The operator names that source and the display follows
   * it — same per-user folder, different root.
   */
  it('is the server path when no host dir is configured', async () => {
    const inbox = await mkdtemp(path.join(os.tmpdir(), 'ci-inbox-'));

    await withInbox(inbox, async () => {
      await withInboxHostDir('', async () => {
        expect(userInboxDisplayDir(OWNER)).toBe(userInboxDir(OWNER));
      });
      // Whitespace is "not configured", not a folder named ' '.
      await withInboxHostDir('   ', async () => {
        expect(userInboxDisplayDir(OWNER)).toBe(userInboxDir(OWNER));
      });
    });
  });

  it('re-roots the same user folder under the host dir when one is configured', async () => {
    const inbox = await mkdtemp(path.join(os.tmpdir(), 'ci-inbox-'));

    await withInbox(inbox, async () => {
      await withInboxHostDir(
        '/home/owner/.local/share/companion-hub/app-data/ci-memory/data/import-work/inbox',
        async () => {
          expect(userInboxDisplayDir(OWNER)).toBe(
            `/home/owner/.local/share/companion-hub/app-data/ci-memory/data/import-work/inbox/${OWNER}`,
          );
          // The server path is untouched: the resolvers keep working where the
          // API actually runs.
          expect(userInboxDir(OWNER)).toBe(path.join(inbox, OWNER));
        },
      );
    });
  });

  it('is not resolved against the container and tolerates a trailing slash', async () => {
    const inbox = await mkdtemp(path.join(os.tmpdir(), 'ci-inbox-'));

    await withInbox(inbox, async () => {
      // A host path is a label from another filesystem namespace — resolving
      // it here would glue the API's cwd onto it and name a folder that
      // exists nowhere.
      await withInboxHostDir('import-work/inbox/', async () => {
        expect(userInboxDisplayDir(OWNER)).toBe(`import-work/inbox/${OWNER}`);
      });
    });
  });

  it("allows the caller's subtree and refuses everything else", async () => {
    // The consume-side resolver: ONE user's slice, nothing else. A file under
    // CI_IMPORT_ROOTS is the user's own and must never reach the code that
    // moves or deletes; another account's subtree and the shared root are not
    // the caller's to consume either.
    const inbox = await mkdtemp(path.join(os.tmpdir(), 'ci-inbox-'));
    const root = await mkdtemp(path.join(os.tmpdir(), 'ci-roots-'));
    const rootFile = path.join(root, 'export.zip');

    await mkdir(path.join(inbox, OWNER), { recursive: true });
    await mkdir(path.join(inbox, MEMBER), { recursive: true });

    const mine = path.join(inbox, OWNER, 'export.zip');
    const theirs = path.join(inbox, MEMBER, 'export.zip');
    const shared = path.join(inbox, 'export.zip');

    await writeFile(mine, 'bytes');
    await writeFile(theirs, 'bytes');
    await writeFile(shared, 'bytes');
    await writeFile(rootFile, 'bytes');

    await withRoots([root], () =>
      withInbox(inbox, async () => {
        expect(await resolveWithinUserInbox(mine, OWNER)).toContain('export.zip');

        for (const refused of [theirs, shared, rootFile]) {
          await expect(resolveWithinUserInbox(refused, OWNER)).rejects.toBeInstanceOf(
            PathOutsideImportRootsError,
          );
        }
      }),
    );
  });
});

describe('realUserInboxDir', () => {
  /**
   * The invariant it exists for: a unit's resolved path, taken relative to it,
   * NAMES the unit. Against `userInboxDir()` under a symlinked mount the same
   * subtraction yields a `../../…` escape — which is how the service drop
   * folder a unit sits in went missing from what its run declared, and how a
   * claim recorded on the resolved path matched no unit the scan listed.
   */
  it('agrees with what the resolver returns, symlinked mount and all', async () => {
    const real = await mkdtemp(path.join(os.tmpdir(), 'ci-inbox-real-'));
    const link = `${real}-link`;

    await mkdir(path.join(real, OWNER, 'reddit'), { recursive: true });
    await writeFile(path.join(real, OWNER, 'reddit', 'export.zip'), 'bytes');
    await symlink(real, link);

    await withInbox(link, async () => {
      const unit = path.join(userInboxDir(OWNER), 'reddit', 'export.zip');
      const resolved = await resolveWithinUserInbox(unit, OWNER);

      expect(path.relative(await realUserInboxDir(OWNER), resolved)).toBe(path.join('reddit', 'export.zip'));
      // And the configured spelling is exactly what does NOT hold.
      expect(path.relative(userInboxDir(OWNER), resolved)).toContain('..');
    });
  });

  it('falls back to the configured path for a subtree that is not provisioned yet', async () => {
    const inbox = await mkdtemp(path.join(os.tmpdir(), 'ci-inbox-'));

    await withInbox(inbox, async () => {
      // Only ever a comparison step, so an account whose folder the boot sweep
      // has not created yet gets a usable root instead of an exception.
      expect(await realUserInboxDir(OWNER)).toBe(userInboxDir(OWNER));
    });
  });
});

describe('resolveWithinRoots', () => {
  it('refuses everything over an empty root set', async () => {
    await expect(resolveWithinRoots('/etc/passwd', [])).rejects.toBeInstanceOf(PathOutsideImportRootsError);
  });
});
