import { BadRequestException } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';

import { ImportInboxTool } from '../ImportInboxTool';
import { ImportScanInboxTool } from '../ImportScanInboxTool';

/**
 * The inbox intents, as an agent sees them.
 *
 * The labels ARE behavior here: `import.import_inbox` is the one import intent
 * marked destructive, because it removes entries from a folder the user
 * manages — a dispatcher gates on that flag, so getting it wrong either nags
 * for a harmless scan or silently consumes a folder. And refusals come back as
 * results, because an agent can act on "too many units" where a thrown error
 * reads as a malfunction.
 */

const ctx = { userId: 'user-1' } as RequestContext;

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

describe('ImportScanInboxTool', () => {
  it('is a read-only intent and passes the scan through with guidance', async () => {
    const scan = jest.fn(async () => ({
      available: true,
      inboxDir: '/inbox',
      displayDir: '/inbox',
      units: [{ path: 'export.zip', kind: 'file' }],
      skippedSymlinks: 0,
      truncated: false,
    }));
    const tool = new ImportScanInboxTool({ scan } as never, makeLogger() as never);

    expect(tool.schema.privacy).toMatchObject({ access: 'read', destructive: false });

    const result = await tool.execute(ctx, {});
    const data = result.data as { units: unknown[]; note: string };

    expect(scan).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(data.units).toHaveLength(1);
    expect(data.note).toContain('import.import_inbox');
  });
});

describe('ImportInboxTool', () => {
  it('is write + destructive — consuming the inbox needs the higher bar', () => {
    const tool = new ImportInboxTool({} as never, makeLogger() as never);

    expect(tool.schema.privacy).toMatchObject({ access: 'write', destructive: true });
    // The consume contract is stated where a dispatcher (and its user) reads it.
    expect(tool.schema.description).toContain('REMOVED');
  });

  it('starts a batch and reports per-unit results', async () => {
    const startBatch = jest.fn(async () => ({
      results: [
        { unit: 'a.zip', runId: 'run-1', label: 'a.zip' },
        { unit: 'b.zip', error: 'b.zip is already being imported by another run' },
      ],
    }));
    const tool = new ImportInboxTool({ startBatch } as never, makeLogger() as never);

    const result = await tool.execute(ctx, { units: ['a.zip', 'b.zip'] });
    const data = result.data as { started: boolean; results: Array<{ runId?: string }> };

    expect(startBatch).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { units: ['a.zip', 'b.zip'], label: null, source: 'mcp' },
    );
    expect(data.started).toBe(true);
    expect(data.results[1].runId).toBeUndefined();
  });

  it('returns a cap refusal instead of throwing it', async () => {
    const startBatch = jest.fn(async () => {
      throw new BadRequestException('A batch starts at most 100 imports; this one names 130.');
    });
    const tool = new ImportInboxTool({ startBatch } as never, makeLogger() as never);

    const result = await tool.execute(ctx, {});
    const data = result.data as { started: boolean; reason: string };

    expect(data.started).toBe(false);
    expect(data.reason).toContain('at most 100');
  });
});
