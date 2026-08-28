import { BadRequestException } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';

import { ImportInboxController } from '../ImportInboxController';

/**
 * A thin surface over ImportInboxService — the walk, caps, containment, and
 * per-unit isolation are pinned in the service's own spec. What belongs to the
 * controller is the contract at its edge: the authenticated user is required,
 * the source is stamped `api`, and the body passes through unreshaped.
 */

const ctx = { userId: 'user-1' } as RequestContext;

function build() {
  const scan = jest.fn(async () => ({
    available: true,
    inboxDir: '/inbox',
    displayDir: '/inbox',
    units: [],
  }));
  const startBatch = jest.fn(async () => ({ results: [{ unit: 'a.zip', runId: 'run-1' }] }));
  const controller = new ImportInboxController({ scan, startBatch } as never);

  return { controller, scan, startBatch };
}

describe('ImportInboxController', () => {
  it('scans as the authenticated user', async () => {
    const { controller, scan } = build();

    await controller.scan(ctx);

    expect(scan).toHaveBeenCalledWith({ userId: 'user-1' });
  });

  it('starts a batch with source api, passing units and label through', async () => {
    const { controller, startBatch } = build();

    const result = await controller.start(ctx, { units: ['a.zip'], label: 'batch' });

    expect(startBatch).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { units: ['a.zip'], label: 'batch', source: 'api' },
    );
    expect(result.results[0]).toMatchObject({ unit: 'a.zip', runId: 'run-1' });
  });

  it('imports everything when the body is empty', async () => {
    const { controller, startBatch } = build();

    await controller.start(ctx, undefined);

    expect(startBatch).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { units: undefined, label: null, source: 'api' },
    );
  });

  it('refuses an unauthenticated caller', async () => {
    const { controller } = build();

    await expect(controller.scan({} as RequestContext)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.start({} as RequestContext, undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
