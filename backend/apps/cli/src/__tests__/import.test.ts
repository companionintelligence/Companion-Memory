import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { importCommand, parseStages, parseTimeout } from '../commands/import';
import { CliError } from '../context';

import { harness } from './support/harness';

const runDetail = (id: string) => ({
  id,
  label: 'takeout.zip',
  source: 'api',
  dataSources: [],
  declaredSources: null,
  status: 'queued',
  percent: 0,
  requestedStages: ['unpack', 'parse', 'media', 'push'],
  error: null,
  createdAt: '1970-01-01T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  stages: [],
});

describe('ci import', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ci-cli-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uploads the file and starts a run over the drop it created', async () => {
    const archive = path.join(dir, 'takeout.zip');

    await writeFile(archive, 'not really a zip');

    const uploaded: string[] = [];
    const started: unknown[] = [];
    const ctx = harness({
      upload: async (file: string) => {
        uploaded.push(file);

        return [
          {
            dropId: 'drop-1',
            originalFilename: 'takeout.zip',
            sizeBytes: 16,
            status: 'staged',
            expiresAt: null,
          },
        ];
      },
      startRun: async (body: unknown) => {
        started.push(body);

        return runDetail('run-1');
      },
    });

    await importCommand(ctx, [archive]);

    expect(uploaded).toEqual([archive]);
    expect(started).toEqual([{ dropId: 'drop-1', label: undefined, stages: undefined }]);
    expect(ctx.term.text()).toContain('run-1');
    expect(ctx.term.text()).toContain('1 run(s) started');
  });

  it('refuses a directory and points at the inbox instead', async () => {
    const folder = path.join(dir, 'Takeout');

    await mkdir(folder);

    const ctx = harness({});

    await expect(importCommand(ctx, [folder])).rejects.toBeInstanceOf(CliError);
    expect(ctx.term.errorText()).toContain('ci inbox --start');
  });

  it('isolates one bad path from its siblings but still exits non-zero', async () => {
    const good = path.join(dir, 'good.zip');

    await writeFile(good, 'x');

    const ctx = harness({
      upload: async () => [
        { dropId: 'drop-1', originalFilename: 'good.zip', sizeBytes: 1, status: 'staged', expiresAt: null },
      ],
      startRun: async () => runDetail('run-1'),
    });

    await expect(importCommand(ctx, [good, path.join(dir, 'missing.zip')])).rejects.toMatchObject({
      // Some work landed, so this is the caller's-fault code, not ours.
      exitCode: 2,
    });

    expect(ctx.term.text()).toContain('run-1');
    expect(ctx.term.errorText()).toContain('missing.zip');
  });

  it('warns when --stages parses media without storing it', async () => {
    const archive = path.join(dir, 'photos.zip');

    await writeFile(archive, 'x');

    const ctx = harness({
      upload: async () => [
        { dropId: 'd', originalFilename: 'photos.zip', sizeBytes: 1, status: 'staged', expiresAt: null },
      ],
      startRun: async () => runDetail('run-2'),
    });

    await importCommand(ctx, [archive], { stages: 'unpack,parse' });

    expect(ctx.term.errorText()).toContain("--stages omits 'media'");
  });

  it('follows the runs with --wait', async () => {
    const archive = path.join(dir, 'a.zip');

    await writeFile(archive, 'x');

    let polls = 0;
    const ctx = harness({
      upload: async () => [
        { dropId: 'd', originalFilename: 'a.zip', sizeBytes: 1, status: 'staged', expiresAt: null },
      ],
      startRun: async () => runDetail('run-3'),
      getRun: async () => {
        polls += 1;

        return { ...runDetail('run-3'), status: 'completed', percent: 100 };
      },
    });

    await importCommand(ctx, [archive], { wait: true });

    expect(polls).toBe(1);
    expect(ctx.term.text()).toContain('completed');
  });
});

describe('parseStages', () => {
  it('accepts the canonical vocabulary', () => {
    expect(parseStages('unpack,parse')).toEqual(['unpack', 'parse']);
    expect(parseStages(undefined)).toBeUndefined();
  });

  it('names the typo and the valid set', () => {
    expect(() => parseStages('unpack,parze')).toThrow(/parze/);
    expect(() => parseStages('unpack,parze')).toThrow(/unpack, parse, media, push/);
  });
});

describe('parseTimeout', () => {
  it('reads seconds and defaults to no limit', () => {
    expect(parseTimeout('30')).toBe(30_000);
    expect(parseTimeout(undefined)).toBe(0);
  });

  it('refuses nonsense', () => {
    expect(() => parseTimeout('soon')).toThrow(CliError);
  });
});
