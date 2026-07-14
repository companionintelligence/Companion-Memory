import type { Repository } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { DeviceService } from '@ci/domains/devices';
import type { EventService } from '@ci/domains/events';

import type { PositionEntity } from '../../entities/PositionEntity';
import { PositionService } from '../PositionService';

const ctx = { userId: '00000000-0000-0000-0000-0000000000aa' } as UserServiceContext;

function makeService() {
  const created: Record<string, unknown>[] = [];
  const repository = {
    // Pass-through create so the spec can assert exactly what would be persisted.
    create: jest.fn((row: Record<string, unknown>) => {
      created.push(row);

      return row;
    }),
    save: jest.fn(async (rows: PositionEntity[]) =>
      rows.map((r) => ({ ...r, time: new Date((r as { time: Date }).time) })),
    ),
    find: jest.fn(async () => []), // findExistingByTimes: nothing pre-existing
  } as unknown as Repository<PositionEntity>;

  const deviceService = { findById: jest.fn(async () => null) } as unknown as DeviceService;
  const eventService = { send: jest.fn(async () => undefined) } as unknown as EventService;
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;

  return {
    service: new PositionService(repository, deviceService, eventService, logger),
    repository,
    eventService,
    created,
  };
}

const fix = (over: Record<string, unknown> = {}) => ({
  time: '2026-01-01T00:00:00.000Z',
  source: 'gps' as const,
  location: { x: -73.9857, y: 40.7484 },
  ...over,
});

describe('PositionService bulk-ingest contract (#1672)', () => {
  it('persists the provenance triple when a record carries one', async () => {
    const { service, created } = makeService();

    await service.create(ctx, [
      fix({
        source_type: 'ci-import-tools',
        source_system: 'google_photos',
        source_id: 'IMG_1.jpg',
      }),
    ]);

    expect(created[0]).toMatchObject({
      sourceType: 'ci-import-tools',
      sourceSystem: 'google_photos',
      sourceId: 'IMG_1.jpg',
    });
  });

  it('nulls the triple for live fixes that have no import provenance', async () => {
    const { service, created } = makeService();

    await service.create(ctx, [fix()]);

    expect(created[0]).toMatchObject({ sourceType: null, sourceSystem: null, sourceId: null });
  });

  it('emits PositionCreatedEvent per row by default (live-device path unchanged)', async () => {
    const { service, eventService } = makeService();

    await service.create(ctx, [fix(), fix({ time: '2026-01-01T00:01:00.000Z' })]);

    expect(eventService.send).toHaveBeenCalledTimes(2);
  });

  it('emitCreated:false suppresses the per-row fan-out (bulk plane)', async () => {
    const { service, eventService, repository } = makeService();

    const rows = await service.create(ctx, [fix(), fix({ time: '2026-01-01T00:01:00.000Z' })], {
      emitCreated: false,
    });

    expect(eventService.send).not.toHaveBeenCalled();
    // Rows still persist and return — only the event fan-out is suppressed.
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
  });
});
