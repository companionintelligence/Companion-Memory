import { chmod, mkdtemp, mkdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import config from '@ci/configuration';

import { ImportInboxService, MAX_INBOX_BATCH_UNITS, SCAN_RECOGNITION_TIMING } from '../ImportInboxService';

/**
 * The inbox walk and the batch starter.
 *
 * Recognition is mocked: which importer claims which tree is the parsers'
 * business (covered where the parsers are tested); what is under test here is
 * the UNIT algebra — a recognized directory is ONE unit, an unrecognized one
 * is organization to recurse into, symlinks are never followed, and caps
 * truncate rather than error.
 */

jest.mock('../../datasources/registry', () => ({
  dataSourcesRecognize: jest.fn(async () => []),
  allDataSources: jest.fn(() => [{ name: 'reddit', title: 'Reddit' }]),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { dataSourcesRecognize } = require('../../datasources/registry') as {
  dataSourcesRecognize: jest.Mock;
};

/** Answer `confidence` for any path whose basename is in `names`. */
function recognizeByName(names: Record<string, number>): void {
  dataSourcesRecognize.mockImplementation(async (_ctx: unknown, entry: { filename: string }) => {
    const confidence = names[entry.filename];

    if (confidence == null) {
      return [];
    }

    return [
      {
        data_source: { name: 'mock_source', title: 'Mock Source' },
        recognition: { confidence },
      },
    ];
  });
}

const stubLogger = () =>
  ({ setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn() }) as never;

const ctx = { userId: '00000000-0000-0000-0000-000000000001' };

/** The one account these tests act as, and the folder its email derives. */
const USER_EMAIL = 'tester@example.com';
const USER_FOLDER = 'tester_example.com';

function build(overrides?: { startRun?: jest.Mock; findActiveByPaths?: jest.Mock }) {
  const startRun = overrides?.startRun ?? jest.fn(async () => ({ run: { id: 'run-1', label: 'x' } }));
  const findActiveByPaths = overrides?.findActiveByPaths ?? jest.fn(async () => []);
  const users = {
    findById: jest.fn(async () => ({ id: ctx.userId, email: USER_EMAIL })),
    findAll: jest.fn(async () => [{ id: ctx.userId, email: USER_EMAIL }]),
  };
  const service = new ImportInboxService(
    { startRun } as never,
    { findActiveByPaths } as never,
    users as never,
    stubLogger(),
  );

  return { service, startRun, findActiveByPaths, users };
}

/**
 * Tests address the CALLER's subtree — the directory the service scopes every
 * scan and batch to — so `withInbox` takes that subtree and points the config
 * at its PARENT, the shared root the service derives the subtree from.
 */
async function withInbox<T>(userDir: string, run: () => Promise<T>): Promise<T> {
  const previous = config.import.inboxDir;

  (config.import as { inboxDir: string }).inboxDir = path.dirname(userDir);

  try {
    return await run();
  } finally {
    (config.import as { inboxDir: string }).inboxDir = previous;
  }
}

/** A fresh shared root with the caller's subtree already in it. */
async function freshInbox(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ci-inbox-scan-'));
  const dir = path.join(root, USER_FOLDER);

  await mkdir(dir);

  return dir;
}

/**
 * Where a run's claim on an inbox unit is RECORDED — the RESOLVED path, since
 * every inbox surface reaches the bytes through a resolver that realpaths
 * before it checks containment. A fixture that spells the claim any other way
 * describes a row the importer never writes.
 */
async function claimedPath(inbox: string, unit: string): Promise<string> {
  return path.join(await realpath(inbox), unit);
}

beforeEach(() => {
  dataSourcesRecognize.mockReset();
  dataSourcesRecognize.mockImplementation(async () => []);
});

describe('ImportInboxService.scan', () => {
  it('reports unavailable when the inbox cannot be read, empty when it merely is', async () => {
    const inbox = await freshInbox();
    const { service } = build();

    await withInbox(path.join(inbox, 'not-creatable-\0', USER_FOLDER), async () => {
      const scan = await service.scan(ctx);

      expect(scan.available).toBe(false);
      expect(scan.units).toEqual([]);
    });

    await withInbox(inbox, async () => {
      const scan = await service.scan(ctx);

      expect(scan).toMatchObject({ available: true, units: [], truncated: false });
    });
  });

  it('names the folder as the host sees it when the operator says where the mount is', async () => {
    // The API runs in a container; the person dropping files does not. The
    // scan keeps `inboxDir` (what the resolvers use) and adds the host-side
    // spelling for the UI/CLI to show — the same per-user folder, re-rooted.
    const inbox = await freshInbox();
    const { service } = build();
    const previous = config.import.inboxHostDir;

    (config.import as { inboxHostDir: string }).inboxHostDir = '/srv/companion/import-work/inbox';

    try {
      await withInbox(inbox, async () => {
        const scan = await service.scan(ctx);

        expect(scan.inboxDir).toBe(inbox);
        expect(scan.displayDir).toBe(`/srv/companion/import-work/inbox/${USER_FOLDER}`);
      });

      // Reported on the unavailable branch too: "not readable" is exactly when
      // someone will go looking for the folder.
      await withInbox(path.join(inbox, 'not-creatable-\0', USER_FOLDER), async () => {
        const scan = await service.scan(ctx);

        expect(scan.available).toBe(false);
        expect(scan.displayDir).toBe(`/srv/companion/import-work/inbox/${USER_FOLDER}`);
      });
    } finally {
      (config.import as { inboxHostDir: string }).inboxHostDir = previous;
    }

    // Without one, the display IS the server path — bare metal has no mount to translate.
    await withInbox(inbox, async () => {
      const scan = await service.scan(ctx);

      expect(scan.displayDir).toBe(scan.inboxDir);
    });
  });

  it('creates a missing user subtree world-writable with the sticky bit, like /tmp', async () => {
    // The api container runs as root: without the chmod the folder lands on
    // the host root-owned 755 and the desktop user cannot move archives in —
    // which is the entire point of the folder.
    const parent = await mkdtemp(path.join(os.tmpdir(), 'ci-inbox-scan-'));
    const inbox = path.join(parent, USER_FOLDER);
    const { service } = build();

    await withInbox(inbox, async () => {
      const scan = await service.scan(ctx);

      expect(scan.available).toBe(true);
    });

    expect((await stat(inbox)).mode & 0o7777).toBe(0o1777);
  });

  it('leaves an existing inbox mode alone — a tightened operator mode stays tightened', async () => {
    const inbox = await freshInbox();

    await chmod(inbox, 0o750);

    const { service } = build();

    await withInbox(inbox, async () => {
      await service.scan(ctx);
    });

    expect((await stat(inbox)).mode & 0o7777).toBe(0o750);
  });

  it('lists top-level entries as the units: root files individually, folders whole', async () => {
    const inbox = await freshInbox();

    await writeFile(path.join(inbox, 'contacts.vcf'), 'BEGIN:VCARD');
    await mkdir(path.join(inbox, 'phone', 'old'), { recursive: true });
    await writeFile(path.join(inbox, 'phone', 'old', 'sms.xml'), '<smses/>');
    await writeFile(path.join(inbox, '.DS_Store'), 'junk');
    await writeFile(path.join(inbox, '.hidden'), 'junk');

    const { service } = build();

    await withInbox(inbox, async () => {
      const scan = await service.scan(ctx);

      // The folder the user dropped is the unit — never a bare inner file.
      expect(scan.units.map((unit) => unit.path)).toEqual(['contacts.vcf', 'phone']);
      expect(scan.units[0]).toMatchObject({ kind: 'file', fileCount: 1 });
      expect(scan.units[1]).toMatchObject({ kind: 'directory', fileCount: 1 });
    });
  });

  it('reports a content-bearing folder as ONE unit, whole subtree, with its chips', async () => {
    const inbox = await freshInbox();

    await mkdir(path.join(inbox, 'takeout', 'Mail'), { recursive: true });
    await writeFile(path.join(inbox, 'takeout', 'Mail', 'a.mbox'), 'aaaa');
    await writeFile(path.join(inbox, 'takeout', 'Mail', 'b.mbox'), 'bb');

    recognizeByName({ takeout: 0.9 });

    const { service } = build();

    await withInbox(inbox, async () => {
      const scan = await service.scan(ctx);

      expect(scan.units).toHaveLength(1);
      expect(scan.units[0]).toMatchObject({
        path: 'takeout',
        kind: 'directory',
        fileCount: 2,
        sizeBytes: 6,
      });
      expect(scan.units[0].recognized[0]).toMatchObject({ dataSource: 'mock_source' });
    });
  });

  it('reports a folder nothing recognizes as a unit all the same — location decides', async () => {
    const inbox = await freshInbox();

    await mkdir(path.join(inbox, 'stuff'), { recursive: true });
    await writeFile(path.join(inbox, 'stuff', 'export.zip'), 'zip');

    recognizeByName({ stuff: 0.2 });

    const { service } = build();

    await withInbox(inbox, async () => {
      const scan = await service.scan(ctx);

      // What sits at the top level is what the user meant to import;
      // recognition only paints chips, it no longer decides unit boundaries.
      expect(scan.units.map((unit) => unit.path)).toEqual(['stuff']);
      expect(scan.units[0].kind).toBe('directory');
    });
  });

  it('omits a folder whose only files sit deeper than the probe looks', async () => {
    const inbox = await freshInbox();

    // Files at depth 5 — below FILE_PROBE_DEPTH (4).
    await mkdir(path.join(inbox, 'deep', 'a', 'b', 'c', 'd'), { recursive: true });
    await writeFile(path.join(inbox, 'deep', 'a', 'b', 'c', 'd', 'file.txt'), 'x');
    // Files at depth 4 — exactly at the probe's reach.
    await mkdir(path.join(inbox, 'reachable', 'a', 'b', 'c'), { recursive: true });
    await writeFile(path.join(inbox, 'reachable', 'a', 'b', 'c', 'file.txt'), 'x');

    const { service } = build();

    await withInbox(inbox, async () => {
      expect((await service.scan(ctx)).units.map((unit) => unit.path)).toEqual(['reachable']);
    });
  });

  it('never follows symlinks, and counts what it skipped', async () => {
    const inbox = await freshInbox();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'ci-outside-'));

    await writeFile(path.join(outside, 'secret.zip'), 'secret');
    await symlink(path.join(outside, 'secret.zip'), path.join(inbox, 'link.zip'));
    await symlink(outside, path.join(inbox, 'linkdir'));
    await writeFile(path.join(inbox, 'real.zip'), 'real');

    const { service } = build();

    await withInbox(inbox, async () => {
      const scan = await service.scan(ctx);

      expect(scan.units.map((unit) => unit.path)).toEqual(['real.zip']);
      expect(scan.skippedSymlinks).toBe(2);
    });
  });

  it('marks units an unfinished run already claims', async () => {
    const inbox = await freshInbox();
    const file = await claimedPath(inbox, 'export.zip');

    await writeFile(file, 'bytes');

    const { service } = build({
      findActiveByPaths: jest.fn(async () => [{ sourcePath: file, runId: 'run-9', userId: ctx.userId }]),
    });

    await withInbox(inbox, async () => {
      const scan = await service.scan(ctx);

      expect(scan.units[0]).toMatchObject({ activeRunId: 'run-9', claimed: true });
    });
  });

  it('matches those claims through a SYMLINKED inbox path, where the two disagree', async () => {
    // The claim half of the same namespace split the declaration test pins:
    // a run records the path the resolver produced — a realpath — so a lookup
    // spelled the configured way matches nothing once the inbox crosses a
    // symlink, and a unit another run is already importing reads as free.
    const real = await mkdtemp(path.join(os.tmpdir(), 'ci-inbox-real-'));
    const linkRoot = `${real}-link`;

    await symlink(real, linkRoot);
    await mkdir(path.join(real, USER_FOLDER), { recursive: true });
    await writeFile(path.join(real, USER_FOLDER, 'export.zip'), 'bytes');

    const claimed = path.join(await realpath(real), USER_FOLDER, 'export.zip');
    const { service, findActiveByPaths } = build({
      findActiveByPaths: jest.fn(async () => [{ sourcePath: claimed, runId: 'run-9', userId: ctx.userId }]),
    });

    // Point config at the LINK, so inboxDir and the recorded claim differ.
    await withInbox(path.join(linkRoot, USER_FOLDER), async () => {
      const scan = await service.scan(ctx);

      expect(scan.units[0]).toMatchObject({ activeRunId: 'run-9', claimed: true });
    });

    expect(findActiveByPaths).toHaveBeenCalledWith([claimed]);
  });

  /**
   * The inbox is ONE folder shared by every account on the appliance. Reporting
   * only the caller's own claims let two users start runs over the same
   * archive, and `UnpackStage` acquires BY RENAME — so the first run to reach
   * the move took the bytes into its own scratch tree and imported another
   * person's export into its own account, while the second found nothing where
   * its claim said there was something.
   */
  it('marks a unit another account is importing as claimed, without exposing their run', async () => {
    const inbox = await freshInbox();
    const file = await claimedPath(inbox, 'export.zip');

    await writeFile(file, 'bytes');

    const { service, findActiveByPaths } = build({
      findActiveByPaths: jest.fn(async () => [
        { sourcePath: file, runId: 'run-of-somebody-else', userId: 'ffffffff-0000-0000-0000-000000000009' },
      ]),
    });

    await withInbox(inbox, async () => {
      const scan = await service.scan(ctx);

      expect(scan.units[0].claimed).toBe(true);
      // Their run id is not this caller's to see: it would 404 on the run
      // route and disclose that the run exists on the way.
      expect(scan.units[0].activeRunId).toBeNull();
    });

    // The lookup itself must not be user-scoped, or the claim is invisible.
    expect(findActiveByPaths).toHaveBeenCalledWith([file]);
  });

  it('does not offer a unit another account is importing', async () => {
    const inbox = await freshInbox();
    const claimed = await claimedPath(inbox, 'claimed.zip');

    await writeFile(claimed, 'bytes');

    const { service, startRun } = build({
      findActiveByPaths: jest.fn(async () => [
        { sourcePath: claimed, runId: 'run-live', userId: 'ffffffff-0000-0000-0000-000000000009' },
      ]),
    });

    await withInbox(inbox, async () => {
      expect((await service.startBatch(ctx, { source: 'api' })).results).toEqual([]);
      expect(startRun).not.toHaveBeenCalled();
    });
  });

  it('truncates at the unit cap rather than erroring', async () => {
    const inbox = await freshInbox();

    // 501 files with a fixed-width suffix so lexicographic order is total.
    for (let index = 0; index < 501; index += 1) {
      await writeFile(path.join(inbox, `f${String(index).padStart(4, '0')}.csv`), 'x');
    }

    const { service } = build();

    await withInbox(inbox, async () => {
      const scan = await service.scan(ctx);

      expect(scan.units).toHaveLength(500);
      expect(scan.truncated).toBe(true);
    });
  });

  it('sizing a huge unit does not strand the sources that sort after it', async () => {
    // The regression: `aggregate` used to spend the WALK's entry budget while
    // measuring a recognized directory, so one large export consumed discovery
    // for everything alphabetically after it. On the real corpus a 79,623-file
    // `google-takeout` meant instagram, linkedin, reddit, spotify, twitter,
    // uber and whatsapp never became units at all — the scan just reported
    // `truncated: true` and a caller could not tell what it had lost.
    const inbox = await freshInbox();

    // `big` sorts before `zzz` and holds more entries than the walk's budget.
    const big = path.join(inbox, 'big');
    await mkdir(big);
    for (let index = 0; index < 25_000; index += 1) {
      await writeFile(path.join(big, `f${String(index).padStart(6, '0')}.txt`), 'x');
    }

    await mkdir(path.join(inbox, 'zzz'));
    await writeFile(path.join(inbox, 'zzz', 'export.csv'), 'x');

    recognizeByName({ big: 1, zzz: 1 });

    const { service } = build();

    await withInbox(inbox, async () => {
      const scan = await service.scan(ctx);
      const names = scan.units.map((unit) => unit.path).sort();

      expect(names).toEqual(['big', 'zzz']);
      // `big` is fully measured (25,000 < MAX_UNIT_SIZING_ENTRIES), so nothing
      // here is approximate — the point is that measuring it cost `zzz` nothing.
      expect(scan.units.find((unit) => unit.path === 'big')?.fileCount).toBe(25_000);
      expect(scan.units.every((unit) => unit.sizeApproximate === false)).toBe(true);
    });
  }, 120_000);
});

describe('ImportInboxService.startBatch', () => {
  it('starts one run per unit and isolates per-unit failures', async () => {
    const inbox = await freshInbox();

    await writeFile(path.join(inbox, 'good.vcf'), 'BEGIN:VCARD');
    await writeFile(path.join(inbox, 'claimed.zip'), 'bytes');

    let calls = 0;
    const startRun = jest.fn(async (_ctx: unknown, input: { localSource: { path: string } }) => {
      calls += 1;

      if (input.localSource.path.endsWith('claimed.zip')) {
        throw new Error('claimed.zip is already being imported by another run');
      }

      return { run: { id: `run-${calls}`, label: path.basename(input.localSource.path) } };
    });

    const { service } = build({ startRun });

    await withInbox(inbox, async () => {
      const batch = await service.startBatch(ctx, {
        units: ['good.vcf', 'claimed.zip', 'missing.zip'],
        source: 'api',
      });

      expect(batch.results).toHaveLength(3);
      // Enqueue order is size-ascending now, so the run id is whichever slot
      // good.vcf drew — what matters is that it started.
      expect(batch.results[0].unit).toBe('good.vcf');
      expect(batch.results[0].runId).toEqual(expect.stringMatching(/^run-/));
      expect(batch.results[1].error).toContain('already being imported');
      // Missing files answer like out-of-bounds ones — fail-closed, isolated.
      expect(batch.results[2].error).toBeTruthy();
      expect(batch.results[2].runId).toBeUndefined();
    });
  });

  it('refuses a traversal escape per unit, touching nothing outside', async () => {
    const inbox = await freshInbox();

    const { service, startRun } = build();

    await withInbox(inbox, async () => {
      const batch = await service.startBatch(ctx, {
        units: ['../../../etc/passwd'],
        source: 'api',
      });

      expect(batch.results[0].error).toBeTruthy();
      expect(startRun).not.toHaveBeenCalled();
    });
  });

  it("refuses another account's subtree, even though it is inside the shared inbox", async () => {
    // The whole point of per-user folders: whoever presses the button imports
    // THEIR folder, not whatever anyone on the appliance has dropped.
    const inbox = await freshInbox();
    const theirs = path.join(path.dirname(inbox), 'mallory_example.com');

    await mkdir(theirs);
    await writeFile(path.join(theirs, 'export.zip'), 'not yours');

    const { service, startRun } = build();

    await withInbox(inbox, async () => {
      const batch = await service.startBatch(ctx, {
        units: ['../mallory_example.com/export.zip'],
        source: 'api',
      });

      expect(batch.results[0].error).toBeTruthy();
      expect(startRun).not.toHaveBeenCalled();

      // And their bytes never show up in this caller's scan either.
      expect((await service.scan(ctx)).units).toEqual([]);
    });
  });

  it('rejects a whole batch over the cap instead of silently truncating it', async () => {
    const inbox = await freshInbox();
    const { service, startRun } = build();

    await withInbox(inbox, async () => {
      await expect(
        service.startBatch(ctx, {
          units: Array.from({ length: MAX_INBOX_BATCH_UNITS + 1 }, (_, index) => `u${index}.zip`),
          source: 'api',
        }),
      ).rejects.toThrow(/at most/);
      expect(startRun).not.toHaveBeenCalled();
    });
  });

  it('imports everything the scan yields when no units are named, skipping claimed ones', async () => {
    const inbox = await freshInbox();
    const claimed = await claimedPath(inbox, 'claimed.zip');

    await writeFile(path.join(inbox, 'a.vcf'), 'BEGIN:VCARD');
    await writeFile(claimed, 'bytes');

    const { service, startRun } = build({
      findActiveByPaths: jest.fn(async () => [
        { sourcePath: claimed, runId: 'run-live', userId: ctx.userId },
      ]),
    });

    await withInbox(inbox, async () => {
      const batch = await service.startBatch(ctx, { source: 'api' });

      expect(batch.results.map((result) => result.unit)).toEqual(['a.vcf']);
      expect(startRun).toHaveBeenCalledTimes(1);
    });
  });
});

describe('service drop folders', () => {
  it('creates the top-level service folders on scan, and only those', async () => {
    const inbox = await freshInbox();
    const { service } = build();

    await withInbox(inbox, async () => {
      await service.scan(ctx);
    });

    expect((await stat(path.join(inbox, 'amazon'))).isDirectory()).toBe(true);
    expect((await stat(path.join(inbox, 'reddit'))).isDirectory()).toBe(true);
    expect((await stat(path.join(inbox, 'google-takeout'))).isDirectory()).toBe(true);
    // Top-level only: per-product subfolders would ask the user to know what
    // is inside their archive.
    await expect(stat(path.join(inbox, 'google-takeout', 'Mail'))).rejects.toThrow();
  });

  it('reports the empty folders as no units at all', async () => {
    const inbox = await freshInbox();
    const { service } = build();

    await withInbox(inbox, async () => {
      // The folders are drop TARGETS, not things to import: an inbox holding
      // only them must read as empty, or the no-units batch would churn.
      expect((await service.scan(ctx)).units).toEqual([]);
    });
  });

  it('declares the folder importers for a unit inside one, nothing for a root unit', async () => {
    const inbox = await freshInbox();

    await mkdir(path.join(inbox, 'reddit'), { recursive: true });
    await writeFile(path.join(inbox, 'reddit', 'export.zip'), 'bytes');
    await writeFile(path.join(inbox, 'loose.zip'), 'bytes');

    const startRun = jest.fn(async () => ({ run: { id: 'run-1', label: 'x' } }));
    const { service } = build({ startRun });

    await withInbox(inbox, async () => {
      await service.startBatch(ctx, { units: ['reddit/export.zip', 'loose.zip'], source: 'api' });
    });

    // Order-agnostic: the batch enqueues size-ascending, not request order.
    expect(startRun).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        declaredSources: ['reddit'],
        localSource: expect.objectContaining({ path: expect.stringContaining('reddit/export.zip') }),
      }),
    );
    expect(startRun).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        declaredSources: undefined,
        localSource: expect.objectContaining({ path: expect.stringContaining('loose.zip') }),
      }),
    );
  });

  it('declares through a SYMLINKED inbox path, where the two paths disagree', async () => {
    // The regression this pins: `resolveWithinRoots` resolves symlinks before
    // its containment check, so the resolved unit path is a realpath, while the
    // inbox directory is composed from config and is not. Where the configured
    // inbox crosses a symlink, `path.relative` between them returns a `../../…`
    // escape whose first segment is never a service folder — so every unit
    // declared NOTHING, silently, and only the usage roll-up degraded.
    //
    // macOS hides this in plain sight (/tmp and /var are symlinks to /private),
    // and any bind-mounted appliance data dir does the same.
    const real = await mkdtemp(path.join(os.tmpdir(), 'ci-inbox-real-'));
    const linkRoot = `${real}-link`;
    await symlink(real, linkRoot);

    const userDirReal = path.join(real, USER_FOLDER);
    await mkdir(path.join(userDirReal, 'reddit'), { recursive: true });
    await writeFile(path.join(userDirReal, 'reddit', 'export.zip'), 'bytes');

    const startRun = jest.fn(async (_ctx: unknown, _input: { declaredSources?: string[] }) => ({
      run: { id: 'run-1', label: 'x' },
    }));
    const { service } = build({ startRun });

    // Point config at the LINK, so inboxDir and the resolved unit path differ.
    await withInbox(path.join(linkRoot, USER_FOLDER), async () => {
      await service.startBatch(ctx, { units: ['reddit/export.zip'], source: 'api' });
    });

    const [, input] = startRun.mock.calls[0];

    expect(input.declaredSources).toEqual(['reddit']);
  });

  it('declares the shared-folder union when several services share one folder', async () => {
    const inbox = await freshInbox();

    await mkdir(path.join(inbox, 'amazon'), { recursive: true });
    await writeFile(path.join(inbox, 'amazon', 'Your Orders.zip'), 'bytes');

    const startRun = jest.fn(async (_ctx: unknown, _input: { declaredSources?: string[] }) => ({
      run: { id: 'run-1', label: 'x' },
    }));
    const { service } = build({ startRun });

    await withInbox(inbox, async () => {
      await service.startBatch(ctx, { units: ['amazon/Your Orders.zip'], source: 'api' });
    });

    const [, input] = startRun.mock.calls[0];

    expect(input.declaredSources).toEqual(
      expect.arrayContaining(['amazon', 'prime_video', 'audible', 'kindle_reading', 'amazon_music']),
    );
  });
});

describe('ImportInboxService.onModuleInit', () => {
  it("creates every existing account's subtree at boot, before any scan", async () => {
    // The folders are drop targets for files moved in BEFORE the app is ever
    // opened, so boot — not the first scan — must be what creates them, for
    // every account the appliance already has.
    const root = await mkdtemp(path.join(os.tmpdir(), 'ci-inbox-scan-'));
    const inbox = path.join(root, USER_FOLDER);
    const { service, users } = build();

    await withInbox(inbox, async () => {
      await service.onModuleInit();
    });

    expect(users.findAll).toHaveBeenCalled();
    expect((await stat(path.join(inbox, 'amazon'))).isDirectory()).toBe(true);
    expect((await stat(path.join(inbox, 'google-takeout'))).isDirectory()).toBe(true);
  });

  it('boots quietly when the inbox cannot be prepared', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ci-inbox-scan-'));
    const notADir = path.join(dir, 'inbox');

    await writeFile(notADir, 'a file where the inbox root should be');

    const { service } = build();

    await withInbox(path.join(notADir, USER_FOLDER), async () => {
      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });
  });

  it('provisions a single new account without touching boot', async () => {
    // The onboarding path: a user row was just created, and their folders
    // must exist without a restart or a first visit to the Inbox panel.
    const root = await mkdtemp(path.join(os.tmpdir(), 'ci-inbox-scan-'));
    const inbox = path.join(root, USER_FOLDER);
    const { service } = build();

    await withInbox(inbox, async () => {
      await service.provisionUserInbox(USER_EMAIL);
    });

    expect((await stat(inbox)).mode & 0o7777).toBe(0o1777);
    expect((await stat(path.join(inbox, 'reddit'))).isDirectory()).toBe(true);
  });
});

describe('scan under a recognition time budget', () => {
  const original = { ...SCAN_RECOGNITION_TIMING };

  afterEach(() => {
    Object.assign(SCAN_RECOGNITION_TIMING, original);
  });

  /** A recognizer that never answers — a saturated disk, a 350GB half-copy. */
  function recognitionHangs(): void {
    dataSourcesRecognize.mockImplementation(() => new Promise(() => undefined));
  }

  it('lists a folder whose recognition timed out, chipless, marking recognition partial', async () => {
    SCAN_RECOGNITION_TIMING.budgetMs = 200;
    SCAN_RECOGNITION_TIMING.perCallMs = 20;

    const inbox = await freshInbox();

    await mkdir(path.join(inbox, 'takeout', 'Mail'), { recursive: true });
    await writeFile(path.join(inbox, 'takeout', 'Mail', 'a.mbox'), 'aaaa');

    recognitionHangs();

    const { service } = build();

    await withInbox(inbox, async () => {
      const scan = await service.scan(ctx);

      // Units are decided by location now, so a merely-slow disk cannot hide
      // the archive; only its chips are missing, and recognitionPartial —
      // never truncated, which means dropped UNITS — says why.
      expect(scan.available).toBe(true);
      expect(scan.units.map((unit) => unit.path)).toEqual(['takeout']);
      expect(scan.units[0].recognized).toEqual([]);
      expect(scan.recognitionPartial).toBe(true);
      expect(scan.truncated).toBe(false);
    });
  });

  it('still lists a file whose recognition timed out, with no chips', async () => {
    SCAN_RECOGNITION_TIMING.budgetMs = 200;
    SCAN_RECOGNITION_TIMING.perCallMs = 20;

    const inbox = await freshInbox();

    await writeFile(path.join(inbox, 'export.zip'), 'bytes');

    recognitionHangs();

    const { service } = build();

    await withInbox(inbox, async () => {
      const scan = await service.scan(ctx);

      // Recognition is advisory on a file — the bytes exist and must show.
      expect(scan.units.map((unit) => unit.path)).toEqual(['export.zip']);
      expect(scan.units[0].recognized).toEqual([]);
    });
  });

  it('stops recognizing entirely once the whole-scan budget is gone', async () => {
    SCAN_RECOGNITION_TIMING.budgetMs = 30;
    SCAN_RECOGNITION_TIMING.perCallMs = 20;

    const inbox = await freshInbox();

    for (let index = 0; index < 5; index += 1) {
      await mkdir(path.join(inbox, `dir-${index}`), { recursive: true });
      await writeFile(path.join(inbox, `dir-${index}`, 'file.csv'), 'x');
    }

    recognitionHangs();

    const { service } = build();

    await withInbox(inbox, async () => {
      const started = Date.now();
      const scan = await service.scan(ctx);

      // Two 20ms calls exhaust a 30ms budget; the other directories are not
      // even attempted. The point is the bound: well under one call per unit.
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(scan.recognitionPartial).toBe(true);
      expect(scan.truncated).toBe(false);
    });
  });
});

describe('scan recognition cache', () => {
  it('reuses verdicts for unchanged paths across scans', async () => {
    const inbox = await freshInbox();

    await mkdir(path.join(inbox, 'takeout'), { recursive: true });
    await writeFile(path.join(inbox, 'takeout', 'a.mbox'), 'aaaa');
    await writeFile(path.join(inbox, 'loose.csv'), 'x,y');

    recognizeByName({ takeout: 0.9 });

    const { service } = build();

    await withInbox(inbox, async () => {
      await service.scan(ctx);
      const callsAfterFirst = dataSourcesRecognize.mock.calls.length;

      const second = await service.scan(ctx);

      // Nothing changed on disk, so the second scan asks the recognizers
      // nothing — every verdict comes from the cache — and still reports the
      // same units.
      expect(dataSourcesRecognize.mock.calls.length).toBe(callsAfterFirst);
      expect(second.units.map((unit) => unit.path)).toEqual(['loose.csv', 'takeout']);
    });
  });

  it('re-recognizes a path whose content stamp changed', async () => {
    const inbox = await freshInbox();
    const file = path.join(inbox, 'export.csv');

    await writeFile(file, 'v1');

    const { service } = build();

    await withInbox(inbox, async () => {
      await service.scan(ctx);
      const callsAfterFirst = dataSourcesRecognize.mock.calls.length;

      await writeFile(file, 'v2-now-longer');
      await service.scan(ctx);

      expect(dataSourcesRecognize.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });
  });

  it('never caches a timeout — the next scan gets a fresh attempt', async () => {
    SCAN_RECOGNITION_TIMING.budgetMs = 200;
    SCAN_RECOGNITION_TIMING.perCallMs = 20;

    try {
      const inbox = await freshInbox();

      await mkdir(path.join(inbox, 'takeout'), { recursive: true });
      await writeFile(path.join(inbox, 'takeout', 'a.mbox'), 'aaaa');

      dataSourcesRecognize.mockImplementation(() => new Promise(() => undefined));

      const { service } = build();

      await withInbox(inbox, async () => {
        const first = await service.scan(ctx);

        expect(first.units.map((unit) => unit.path)).toEqual(['takeout']);
        expect(first.units[0].recognized).toEqual([]);

        // The disk quieted down: recognition answers now, and the earlier
        // timeout must not have been remembered as "unrecognizable".
        recognizeByName({ takeout: 0.9 });

        const second = await service.scan(ctx);

        expect(second.units[0].recognized[0]).toMatchObject({ dataSource: 'mock_source' });
      });
    } finally {
      Object.assign(SCAN_RECOGNITION_TIMING, { budgetMs: 10_000, perCallMs: 3_000 });
    }
  });
});

describe('folder-scoped recognition', () => {
  it("asks only the folder's importers inside a service folder, everyone at the root", async () => {
    const inbox = await freshInbox();

    await mkdir(path.join(inbox, 'reddit'), { recursive: true });
    await writeFile(path.join(inbox, 'reddit', 'export.zip'), 'bytes');
    await writeFile(path.join(inbox, 'loose.zip'), 'bytes');

    const { service } = build();

    await withInbox(inbox, async () => {
      await service.scan(ctx);
    });

    const optsFor = (suffix: string) => {
      const call = dataSourcesRecognize.mock.calls.find((c) =>
        (c[1] as { fullPath: string }).fullPath.endsWith(suffix),
      );
      // A miss means the scan never recognized this path at all — a different
      // failure from "recognized, but unscoped". Assert it, so it reports as
      // one instead of throwing a bare TypeError off the `.only` read.
      expect(call).toBeDefined();

      return call![3] as { only?: ReadonlySet<string> };
    };

    // The reddit FOLDER is the unit, recognized with only its importer —
    // the all-importers fan-out is the scan's dominant cost.
    expect(optsFor('/reddit').only).toEqual(new Set(['reddit']));
    // loose.zip sits at the root, where the location says nothing.
    expect(optsFor('loose.zip').only).toBeUndefined();
  });

  it('scopes a shared folder to the whole family, not one member', async () => {
    const inbox = await freshInbox();

    await mkdir(path.join(inbox, 'amazon'), { recursive: true });
    await writeFile(path.join(inbox, 'amazon', 'Your Orders.zip'), 'bytes');

    const { service } = build();

    await withInbox(inbox, async () => {
      await service.scan(ctx);
    });

    const call = dataSourcesRecognize.mock.calls.find((c) =>
      (c[1] as { fullPath: string }).fullPath.endsWith('/amazon'),
    );
    expect(call).toBeDefined();
    const only = (call![3] as { only?: ReadonlySet<string> }).only;

    expect(only).toEqual(new Set(['amazon', 'prime_video', 'audible', 'kindle_reading', 'amazon_music']));
  });
});

describe('unit chips', () => {
  it('dedupes sibling matches of one importer into a single chip', async () => {
    const inbox = await freshInbox();

    await mkdir(path.join(inbox, 'mail'), { recursive: true });
    await writeFile(path.join(inbox, 'mail', 'a.mbox'), 'x');

    // Thirty mboxes, one importer: the registry reports every sibling match.
    dataSourcesRecognize.mockImplementation(async () =>
      Array.from({ length: 30 }, (_, index) => ({
        data_source: { name: 'email', title: 'Email' },
        recognition: { confidence: index === 3 ? 0.9 : 0.6 },
      })),
    );

    const { service } = build();

    await withInbox(inbox, async () => {
      const scan = await service.scan(ctx);

      expect(scan.units[0].recognized).toEqual([{ dataSource: 'email', title: 'Email', confidence: 0.9 }]);
    });
  });

  it("carries the folder's declared services as titles, empty at the root", async () => {
    const inbox = await freshInbox();

    await mkdir(path.join(inbox, 'reddit'), { recursive: true });
    // A zip: recognizers cannot see inside it, so recognition stays empty and
    // the declared titles are all the panel has to say what this will import as.
    await writeFile(path.join(inbox, 'reddit', 'export.zip'), 'bytes');
    await writeFile(path.join(inbox, 'loose.zip'), 'bytes');

    const { service } = build();

    await withInbox(inbox, async () => {
      const scan = await service.scan(ctx);
      const reddit = scan.units.find((unit) => unit.path === 'reddit');
      const loose = scan.units.find((unit) => unit.path === 'loose.zip');

      expect(reddit?.recognized).toEqual([]);
      expect(reddit?.declared).toEqual(['Reddit']);
      expect(loose?.declared).toEqual([]);
    });
  });
});

describe('startBatch enqueue order', () => {
  it('starts runs smallest-first while the response keeps request order', async () => {
    const inbox = await freshInbox();

    await writeFile(path.join(inbox, 'big.zip'), 'x'.repeat(5_000));
    await writeFile(path.join(inbox, 'small.zip'), 'x');
    await writeFile(path.join(inbox, 'medium.zip'), 'x'.repeat(100));

    const started: string[] = [];
    const startRun = jest.fn(async (_ctx: unknown, input: { localSource: { path: string } }) => {
      started.push(path.basename(input.localSource.path));

      return { run: { id: `run-${started.length}`, label: 'x' } };
    });
    const { service } = build({ startRun });

    await withInbox(inbox, async () => {
      const batch = await service.startBatch(ctx, {
        units: ['big.zip', 'medium.zip', 'small.zip'],
        source: 'api',
      });

      // The queue is finite-slot: every quick win must land before the
      // monster takes its slot.
      expect(started).toEqual(['small.zip', 'medium.zip', 'big.zip']);
      // But a client that lined its rows up with its request sees its order.
      expect(batch.results.map((result) => result.unit)).toEqual(['big.zip', 'medium.zip', 'small.zip']);
    });
  });
});
