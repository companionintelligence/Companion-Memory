import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { ServiceContext, UserServiceContext } from '@ci/common/context';
import { EventService as SignallingEventService } from '@ci/domains/events';

import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { EventService } from '../EventService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

import { noopGraphDeltaWriter } from './harness/noopGraphDeltaWriter';

const ctx = { userId: 'user-1' } as ServiceContext;

function existing(overrides: Partial<EventEntity> = {}): EventEntity {
  return {
    id: 'e1',
    startTime: new Date('2026-08-03T14:00:00Z'),
    endTime: new Date('2026-08-03T15:30:00Z'),
    sourceSystem: null,
    externalSyncStatus: null,
    ...overrides,
  } as EventEntity;
}

describe('EventService.reschedule — moving an event on the calendar', () => {
  let service: EventService;
  let repo: { findOne: jest.Mock; save: jest.Mock; find: jest.Mock };
  let signalling: { send: jest.Mock };
  let saved: EventEntity | undefined;

  async function setup(row: EventEntity | null) {
    saved = undefined;
    repo = {
      findOne: jest.fn(async () => row),
      save: jest.fn(async (entity: EventEntity) => {
        saved = entity;

        return entity;
      }),
      find: jest.fn(async () => []),
    };
    signalling = { send: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        EventService,
        { provide: getRepositoryToken(EventEntity), useValue: repo },
        // The base row owns title/description; the read-back composes it in.
        { provide: getRepositoryToken(EventBaseEntity), useValue: { find: jest.fn(async () => []) } },
        { provide: SignallingEventService, useValue: signalling },
        { provide: DataSource, useValue: { getRepository: jest.fn() } },
        { provide: GraphDeltaWriter, useValue: noopGraphDeltaWriter() },
      ],
    }).compile();

    service = moduleRef.get(EventService);
  }

  const newStart = new Date('2026-08-06T10:00:00Z');

  it('preserves the duration when only a start is given', async () => {
    await setup(existing());

    await service.reschedule(ctx, 'e1', newStart);

    // 90 minutes in, 90 minutes out.
    expect(saved?.startTime).toEqual(newStart);
    expect(saved?.endTime).toEqual(new Date('2026-08-06T11:30:00Z'));
  });

  it('honours an explicit end time', async () => {
    await setup(existing());
    const end = new Date('2026-08-06T10:30:00Z');

    await service.reschedule(ctx, 'e1', newStart, end);

    expect(saved?.endTime).toBe(end);
  });

  it('leaves an open-ended event open-ended', async () => {
    await setup(existing({ endTime: null }));

    await service.reschedule(ctx, 'e1', newStart);

    expect(saved?.endTime).toBeNull();
  });

  it('marks an externally-sourced event as diverged from its calendar', async () => {
    await setup(existing({ sourceSystem: 'google_calendar' }));

    await service.reschedule(ctx, 'e1', newStart);

    // The move does not reach Google; `pending` is the record that it drifted.
    expect(saved?.externalSyncStatus).toBe('pending');
  });

  it('leaves a locally-created event unmarked', async () => {
    await setup(existing({ sourceSystem: null }));

    await service.reschedule(ctx, 'e1', newStart);

    expect(saved?.externalSyncStatus).toBeNull();
  });

  it('signals the move so search and enrichment re-read the row', async () => {
    await setup(existing());

    await service.reschedule(ctx, 'e1', newStart);

    expect(signalling.send).toHaveBeenCalledTimes(1);
  });

  it('returns null for an event the viewer does not own', async () => {
    await setup(null);

    await expect(service.reschedule(ctx, 'missing', newStart)).resolves.toBeNull();
    expect(repo.save).not.toHaveBeenCalled();
  });
});

/**
 * Stand-in for TypeORM's `repository.create()`, which builds the entity by
 * reading each column off the plain object by its *propertyName* (camelCase)
 * and silently discarding everything it does not recognise. Dropping every
 * snake_case key reproduces that faithfully: a DTO field `toEntityFields`
 * forgets to rename is not a no-op, it is a lost write with no error.
 */
function createLikeTypeorm<T extends object>(plain: T): T {
  return Object.fromEntries(Object.entries(plain).filter(([key]) => !key.includes('_'))) as T;
}

/**
 * Lives beside the reschedule suite because both exercise the same write path
 * through the mocked EventEntity repository — the create()/toEntityFields half
 * of it, which is where a candidate's provenance is either recorded or lost.
 */
describe('EventService.create — provenance survives the DTO mapping', () => {
  let service: EventService;
  let saved: EventEntity | undefined;
  let savedBase: EventBaseEntity | undefined;

  const userCtx = { userId: 'user-1' } as UserServiceContext;

  async function setup() {
    saved = undefined;
    savedBase = undefined;
    const baseRepo = {
      create: jest.fn((plain: EventBaseEntity) => plain),
      save: jest.fn(async (entity: EventBaseEntity) => {
        savedBase = entity;

        return entity;
      }),
      find: jest.fn(async () => []),
    };
    const repo = {
      findOne: jest.fn(async () => null),
      create: jest.fn((plain: EventEntity) => createLikeTypeorm(plain)),
      save: jest.fn(async (entity: EventEntity) => {
        saved = entity;

        return entity;
      }),
      // create() writes both halves of the CTI aggregate in one transaction, so
      // the mock hands back the same repositories through a manager.
      manager: {
        transaction: (run: (manager: unknown) => unknown) =>
          Promise.resolve(
            run({
              getRepository: (target: unknown) => (target === EventBaseEntity ? baseRepo : repo),
            }),
          ),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        EventService,
        { provide: getRepositoryToken(EventEntity), useValue: repo },
        { provide: getRepositoryToken(EventBaseEntity), useValue: baseRepo },
        { provide: SignallingEventService, useValue: { send: jest.fn() } },
        { provide: DataSource, useValue: { getRepository: jest.fn() } },
        { provide: GraphDeltaWriter, useValue: noopGraphDeltaWriter() },
      ],
    }).compile();

    service = moduleRef.get(EventService);
  }

  const start = new Date('2026-08-06T09:00:00Z');

  /** Exactly what CandidateService.accept hands to create() when promoting. */
  const promoted = {
    title: 'Renew passport',
    start_time: start,
    end_time: new Date('2026-08-06T09:45:00Z'),
    category: 'admin',
    energy_level: 3,
    status: 'confirmed',
    is_predicted: false,
    created_by: 'schedule:candidate',
    inference_sources: {
      candidate_id: 'cand-1',
      rationale: 'Expires in six weeks',
      rationale_sources: ['action:42'],
      generator: 'suggestion-sync',
    },
  };

  it('writes the audit trail an accepted candidate carries', async () => {
    await setup();

    await service.create(userCtx, promoted);

    // Without the snake_case -> propertyName rename these four never reach the
    // row and an event minted from a suggestion is indistinguishable from a
    // hand-created one.
    expect(saved?.createdBy).toBe('schedule:candidate');
    expect(saved?.inferenceSources).toEqual(promoted.inference_sources);
    expect(saved?.energyLevel).toBe(3);
  });

  it('records is_predicted: false rather than treating it as absent', async () => {
    await setup();

    await service.create(userCtx, promoted);

    // The user committed to this, so HBPE may train on it — that is an
    // assertion, not a missing value, and a truthiness check would lose it.
    expect(saved).toHaveProperty('isPredicted', false);
  });

  it('returns the provenance on the egress type', async () => {
    await setup();

    const [event] = await service.create(userCtx, promoted);

    expect(event).toMatchObject({
      createdBy: 'schedule:candidate',
      energyLevel: 3,
      isPredicted: false,
    });
  });

  it('leaves provenance unset when the caller says nothing about it', async () => {
    await setup();

    await service.create(userCtx, { title: 'Lunch', start_time: start });

    // Absent must stay absent so the column default applies.
    expect(saved).not.toHaveProperty('isPredicted');
    expect(saved).not.toHaveProperty('createdBy');
    expect(saved).not.toHaveProperty('inferenceSources');
    expect(saved).not.toHaveProperty('energyLevel');
  });

  it('still maps the fields it mapped before', async () => {
    await setup();

    await service.create(userCtx, {
      title: 'Standup',
      start_time: start,
      end_time: new Date('2026-08-06T09:15:00Z'),
      event_type: 'meeting',
      source_type: 'calendar',
      source_system: 'google_calendar',
      source_id: 'gcal-1',
      location_name: 'Room 3',
      organizer_entity_id: 'entity-1',
      participant_entity_ids: ['entity-2'],
      sharing_level: 'household',
    });

    // The title is base-row data now (entities.name), so it is asserted there
    // rather than on the ci.events detail row.
    expect(savedBase).toMatchObject({ name: 'Standup' });

    expect(saved).toMatchObject({
      startTime: start,
      eventType: 'meeting',
      sourceType: 'calendar',
      sourceSystem: 'google_calendar',
      sourceId: 'gcal-1',
      locationName: 'Room 3',
      organizerEntityId: 'entity-1',
      participantEntityIds: ['entity-2'],
      sharingLevel: 'household',
    });
  });
});
