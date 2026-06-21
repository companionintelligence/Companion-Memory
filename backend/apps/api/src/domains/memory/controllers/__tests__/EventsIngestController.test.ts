import type { DataSource } from 'typeorm';

import type { RequestContext } from '@ci/common/context';

import type { EventService } from '../../services/EventService';
import { EventsIngestController } from '../EventsIngestController';

const ctx = { userId: 'user-1' } as RequestContext;

function makeController(opts: {
  captureInserted: boolean[]; // per event: did the capture row insert (new) vs conflict (dup)
  createThrowsAt?: number;
}) {
  const eventService = {
    create: jest.fn(async () => [{ id: 'event-x' }]),
  } as unknown as EventService;

  let insertCall = 0;
  const dataSource = {
    query: jest.fn(async (sql: string) => {
      if (/INSERT INTO\s+ci\.capture_events/.test(sql)) {
        const isNew = opts.captureInserted[insertCall++];

        return isNew ? [{ capture_event_id: `cap-${insertCall}` }] : [];
      }

      return []; // UPDATE
    }),
  } as unknown as DataSource;

  if (opts.createThrowsAt != null) {
    (eventService.create as jest.Mock).mockImplementation(async () => {
      throw new Error('boom');
    });
  }

  return { controller: new EventsIngestController(eventService, dataSource), eventService, dataSource };
}

const ev = (id: string) => ({
  source_system: 'gmail',
  source_id: id,
  kind: 'communication.email',
  occurred_at: '2026-01-01T00:00:00.000Z',
  payload: { Subject: 'hi' },
});

describe('EventsIngestController.ingest', () => {
  it('materializes new captures and counts them as ingested', async () => {
    const { controller, eventService } = makeController({ captureInserted: [true, true] });
    const res = await controller.ingest(ctx, { events: [ev('a'), ev('b')] });
    expect(res.ingested).toBe(2);
    expect(res.duplicate).toBe(0);
    expect(res.rejected).toEqual([]);
    expect(eventService.create).toHaveBeenCalledTimes(2);
  });

  it('counts an already-seen (source_system, source_id) as duplicate, no event created', async () => {
    const { controller, eventService } = makeController({ captureInserted: [false] });
    const res = await controller.ingest(ctx, { events: [ev('a')] });
    expect(res.duplicate).toBe(1);
    expect(res.ingested).toBe(0);
    expect(eventService.create).not.toHaveBeenCalled();
  });

  it('routes capture events to EventService.create with the source triple + kind', async () => {
    const { controller, eventService } = makeController({ captureInserted: [true] });
    await controller.ingest(ctx, { events: [ev('a')] });
    const dto = (eventService.create as jest.Mock).mock.calls[0][1];
    expect(dto).toMatchObject({
      source_type: 'capture',
      source_system: 'gmail',
      source_id: 'a',
      event_type: 'communication.email',
    });
  });

  it('rejects an event whose materialization throws, without failing the batch', async () => {
    const { controller } = makeController({ captureInserted: [true], createThrowsAt: 0 });
    const res = await controller.ingest(ctx, { events: [ev('a')] });
    expect(res.ingested).toBe(0);
    expect(res.rejected).toEqual([{ index: 0, reason: 'boom' }]);
  });
});
