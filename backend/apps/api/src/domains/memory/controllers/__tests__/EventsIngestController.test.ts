import type { DataSource } from 'typeorm';

import type { RequestContext } from '@ci/common/context';

import type { EventService } from '../../services/EventService';
import { EventsIngestController } from '../EventsIngestController';

const ctx = { userId: 'user-1' } as RequestContext;

/**
 * The batch path is set-based: ONE multi-row INSERT into ci.capture_events per
 * request (DO NOTHING RETURNING the genuine inserts), ONE EventService.create for
 * all genuine inserts, ONE UNNEST UPDATE to back-link. The mock returns a capture
 * row only for the events flagged `captureInserted` (the rest conflicted out and
 * count as duplicates), keyed by source_id so the controller can map rows back to
 * their request index.
 */
function makeController(opts: {
  captureInserted: boolean[]; // per event: did the capture row insert (new) vs conflict (dup)
  createThrows?: boolean;
}) {
  const eventService = {
    // Batched create returns one row per input DTO, in input order.
    create: jest.fn(async (_c: unknown, dtos: unknown[]) =>
      (dtos as unknown[]).map((_, i) => ({ id: `event-${i}` })),
    ),
  } as unknown as EventService;

  const dataSource = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      if (/INSERT INTO\s+ci\.capture_events/.test(sql)) {
        // params are flat 7-per-row: [user, system, id, kind, occurred, observed, payload, ...]
        const rows: { capture_event_id: string; source_system: string; source_id: string }[] = [];
        for (let i = 0; i < opts.captureInserted.length; i++) {
          if (!opts.captureInserted[i]) {
            continue;
          }

          const base = i * 7;

          rows.push({
            capture_event_id: `cap-${i}`,
            source_system: params[base + 1] as string,
            source_id: params[base + 2] as string,
          });
        }

        return rows;
      }

      return []; // UNNEST UPDATE
    }),
  } as unknown as DataSource;

  if (opts.createThrows) {
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
    // Set-based: ONE batched create for the whole batch, not one per row.
    expect(eventService.create).toHaveBeenCalledTimes(1);
    expect((eventService.create as jest.Mock).mock.calls[0][1]).toHaveLength(2);
  });

  it('does the capture insert in a single set-based statement', async () => {
    const { controller, dataSource } = makeController({ captureInserted: [true, true, true] });
    await controller.ingest(ctx, { events: [ev('a'), ev('b'), ev('c')] });
    const insertCalls = (dataSource.query as jest.Mock).mock.calls.filter((c) =>
      /INSERT INTO\s+ci\.capture_events/.test(c[0] as string),
    );
    expect(insertCalls).toHaveLength(1);
    // 3 rows × 7 columns = 21 bound params.
    expect((insertCalls[0][1] as unknown[]).length).toBe(21);
  });

  it('counts an already-seen (source_system, source_id) as duplicate, no event created', async () => {
    const { controller, eventService } = makeController({ captureInserted: [false] });
    const res = await controller.ingest(ctx, { events: [ev('a')] });
    expect(res.duplicate).toBe(1);
    expect(res.ingested).toBe(0);
    expect(eventService.create).not.toHaveBeenCalled();
  });

  it('mixes genuine inserts and duplicates in one batch', async () => {
    const { controller, eventService } = makeController({ captureInserted: [true, false, true] });
    const res = await controller.ingest(ctx, { events: [ev('a'), ev('b'), ev('c')] });
    expect(res.ingested).toBe(2);
    expect(res.duplicate).toBe(1);
    // Only the two genuine inserts (a, c) are materialized, in request order.
    const dtos = (eventService.create as jest.Mock).mock.calls[0][1] as { source_id: string }[];
    expect(dtos.map((d) => d.source_id)).toEqual(['a', 'c']);
  });

  it('collapses an intra-batch duplicate (same source key twice) to one insert', async () => {
    // Only the first of the two identical keys reaches the INSERT (captureInserted
    // has one entry); the second is counted as a duplicate before the statement.
    const { controller, eventService, dataSource } = makeController({ captureInserted: [true] });
    const res = await controller.ingest(ctx, { events: [ev('a'), ev('a')] });
    expect(res.ingested).toBe(1);
    expect(res.duplicate).toBe(1);
    // The INSERT carries exactly ONE row (7 params), not two.
    const insertCall = (dataSource.query as jest.Mock).mock.calls.find((c) =>
      /INSERT INTO\s+ci\.capture_events/.test(c[0] as string),
    );
    expect((insertCall![1] as unknown[]).length).toBe(7);
    expect((eventService.create as jest.Mock).mock.calls[0][1]).toHaveLength(1);
  });

  it('routes capture events to EventService.create with the source triple + kind', async () => {
    const { controller, eventService } = makeController({ captureInserted: [true] });
    await controller.ingest(ctx, { events: [ev('a')] });
    const dto = (eventService.create as jest.Mock).mock.calls[0][1][0];
    expect(dto).toMatchObject({
      source_type: 'capture',
      source_system: 'gmail',
      source_id: 'a',
      event_type: 'communication.email',
    });
  });

  it('back-links every capture row to its event in one batched UPDATE', async () => {
    const { controller, dataSource } = makeController({ captureInserted: [true, true] });
    await controller.ingest(ctx, { events: [ev('a'), ev('b')] });
    const updateCalls = (dataSource.query as jest.Mock).mock.calls.filter((c) =>
      /UPDATE\s+ci\.capture_events/.test(c[0] as string),
    );
    expect(updateCalls).toHaveLength(1);
    // capture ids and event ids passed as parallel arrays for UNNEST.
    expect(updateCalls[0][1]).toEqual([
      ['cap-0', 'cap-1'],
      ['event-0', 'event-1'],
    ]);
  });

  it('rejects the whole genuine-insert batch (per originating index) when materialization throws', async () => {
    const { controller } = makeController({ captureInserted: [true, false, true], createThrows: true });
    const res = await controller.ingest(ctx, { events: [ev('a'), ev('b'), ev('c')] });
    expect(res.ingested).toBe(0);
    expect(res.duplicate).toBe(1);
    expect(res.rejected).toEqual([
      { index: 0, reason: 'boom' },
      { index: 2, reason: 'boom' },
    ]);
  });
});
