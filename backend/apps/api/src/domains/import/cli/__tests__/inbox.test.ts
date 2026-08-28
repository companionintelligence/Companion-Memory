import type { InboxUnit } from '../../services/ImportInboxService';
import { inboxCommand, select } from '../commands/inbox';
import { CliError } from '../context';

import { harness } from './support/harness';

const unit = (overrides: Partial<InboxUnit> = {}): InboxUnit => ({
  path: 'takeout.zip',
  kind: 'file',
  sizeBytes: 1024,
  fileCount: 1,
  recognized: [{ dataSource: 'google_photos', title: 'Google Photos', confidence: 0.9 }],
  declared: [],
  activeRunId: null,
  claimed: false,
  sizeApproximate: false,
  ...overrides,
});

const scan = (units: InboxUnit[]) => ({
  available: true as const,
  inboxDir: '/var/lib/ci-import/inbox',
  displayDir: '/var/lib/ci-import/inbox',
  units,
  skippedSymlinks: 0,
  truncated: false,
  recognitionPartial: false,
});

describe('ci-import inbox', () => {
  it('only LOOKS by default — the inbox consumes what it imports', async () => {
    const ctx = harness({ scanInbox: async () => scan([unit()]) });

    await inboxCommand(ctx);

    expect(ctx.term.text()).toContain('takeout.zip');
    expect(ctx.term.text()).toContain('ci-import inbox --start');
    expect(ctx.term.text()).toContain('consumes what it imports');
  });

  it('reports skipped symlinks rather than following them', async () => {
    const ctx = harness({ scanInbox: async () => ({ ...scan([unit()]), skippedSymlinks: 3 }) });

    await inboxCommand(ctx);

    expect(ctx.term.text()).toContain('3 symlink(s) skipped');
  });

  it('starts one run per ready unit with --start', async () => {
    const requested: unknown[] = [];
    const ctx = harness({
      scanInbox: async () => scan([unit(), unit({ path: 'mail.zip' })]),
      startInboxRuns: async (units: string[], label: string | null) => {
        requested.push({ units, label });

        return { results: units.map((u, index) => ({ unit: u, runId: `run-${index}` })) };
      },
    });

    await inboxCommand(ctx, { start: true });

    expect(requested).toEqual([{ units: ['takeout.zip', 'mail.zip'], label: null }]);
    expect(ctx.term.text()).toContain('2 of 2 unit(s) started');
  });

  it('never offers a unit another run already claimed', async () => {
    const requested: string[][] = [];
    const ctx = harness({
      scanInbox: async () => scan([unit({ claimed: true }), unit({ path: 'free.zip' })]),
      startInboxRuns: async (units: string[]) => {
        requested.push(units);

        return { results: units.map((u) => ({ unit: u, runId: 'run-1' })) };
      },
    });

    await inboxCommand(ctx, { start: true });

    expect(requested).toEqual([['free.zip']]);
  });

  it('refuses when the appliance cannot read the inbox, naming the directory', async () => {
    const ctx = harness({
      scanInbox: async () => ({
        available: false as const,
        reason: 'The inbox directory is not readable: ENOENT',
        inboxDir: '/var/lib/ci-import/inbox',
        displayDir: '/var/lib/ci-import/inbox',
        units: [],
        skippedSymlinks: 0,
        truncated: false,
        recognitionPartial: false,
      }),
    });

    await expect(inboxCommand(ctx)).rejects.toThrow(/CI_IMPORT_INBOX_DIR/);
  });

  it('refuses --start when everything matching is already importing', async () => {
    const ctx = harness({ scanInbox: async () => scan([unit({ claimed: true })]) });

    await expect(inboxCommand(ctx, { start: true })).rejects.toThrow(/already being imported/);
  });
});

describe('inbox selection', () => {
  const units = [
    unit({ path: 'photos', recognized: [{ dataSource: 'google_photos', title: 'p', confidence: 0.9 }] }),
    unit({ path: 'mail', recognized: [{ dataSource: 'gmail', title: 'm', confidence: 0.8 }] }),
    unit({ path: 'mystery', recognized: [] }),
  ];

  it('keeps only what --only names', () => {
    expect(select(units, { only: 'gmail' }).map((u) => u.path)).toEqual(['mail']);
  });

  it('drops what --skip names, keeping the unrecognized', () => {
    expect(select(units, { skip: 'gmail' }).map((u) => u.path)).toEqual(['photos', 'mystery']);
  });

  it('takes exact paths from --units and complains about ones the scan did not yield', () => {
    expect(select(units, { units: 'mail,photos' }).map((u) => u.path)).toEqual(['photos', 'mail']);
    expect(() => select(units, { units: 'gone' })).toThrow(CliError);
  });

  describe('a budget-truncated scan says so', () => {
    /**
     * Both numbers and the parser list are budgeted, and the service already
     * records that: `sizeApproximate` per unit, `recognitionPartial` per scan.
     * The CLI printed neither, so a Google Takeout of 79,623 files rendered as
     * "49,788 files / 3.0GB / no parsers" with nothing marking any of it as a
     * floor — 37% and 30% short of the real 79,623 and 4.3GB.
     *
     * The empty parser list is the one that bites: such a unit matches no
     * `--only <source>`, so a run reports success over a smaller corpus than
     * was asked for.
     */
    it('marks an approximate size and file count as a floor', async () => {
      const ctx = harness({
        scanInbox: async () => scan([unit({ path: 'google-takeout', sizeApproximate: true })]),
      });

      await inboxCommand(ctx);

      expect(ctx.term.text()).toContain('~');
      expect(ctx.term.text()).toContain('1+');
      expect(ctx.term.text()).toContain('floors, not measurements');
      expect(ctx.term.text()).toContain('google-takeout');
    });

    it('names the units left with no parsers when recognition ran out', async () => {
      const ctx = harness({
        scanInbox: async () => ({
          ...scan([unit({ path: 'google-takeout', recognized: [] }), unit({ path: 'amazon' })]),
          recognitionPartial: true,
        }),
      });

      await inboxCommand(ctx);

      expect(ctx.term.text()).toContain('Recognition ran out of budget');
      expect(ctx.term.text()).toContain('google-takeout');
      // The unit that DID recognize must not be blamed.
      expect(ctx.term.text()).not.toContain('for: google-takeout, amazon');
      expect(ctx.term.text()).toContain('--only');
    });

    it('stays quiet when nothing was truncated', async () => {
      const ctx = harness({ scanInbox: async () => scan([unit()]) });

      await inboxCommand(ctx);

      expect(ctx.term.text()).not.toContain('Recognition ran out of budget');
      expect(ctx.term.text()).not.toContain('floors, not measurements');
    });
  });
});
