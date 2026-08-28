import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventEntity, EventService, PersonService, UserContextService } from '@ci/domains/memory';
import { PersonalizationService } from '@ci/domains/personalization';

import { PlannedBlockService } from '../PlannedBlockService';
import { PlanningTimeService } from '../PlanningTimeService';
import { TaskService } from '../TaskService';

const CTX = { userId: 'alice-uuid' } as UserServiceContext;

// `computePlacement` clamps its search window to start no earlier than the
// REAL wall clock (`now = new Date()` in `propose()`), which the mocked
// `planningTime.today()` below has to agree with — a hardcoded past date
// here made every gap-search window entirely historical the moment enough
// real time passed, and every test using it failed with `no_gap` regardless
// of what it was actually testing. Derived from `new Date()` so this fixture
// cannot rot the same way again.
const TODAY = new Date().toISOString().slice(0, 10);

const OPEN_TASK = {
  id: 'task-1',
  userId: CTX.userId,
  title: 'Call the dentist',
  description: null,
  status: 'open',
  estimatedMinutes: 30,
  scheduledFor: null,
} as const;

function makeEventQb(row: EventEntity | null) {
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(row),
    getMany: jest.fn().mockResolvedValue(row ? [row] : []),
  };

  return qb;
}

describe('PlannedBlockService', () => {
  let service: PlannedBlockService;
  let eventRepository: { createQueryBuilder: jest.Mock };
  let eventService: {
    findById: jest.Mock;
    findByIds: jest.Mock;
    findInRange: jest.Mock;
    create: jest.Mock;
    remove: jest.Mock;
    reschedule: jest.Mock;
  };
  let taskService: {
    findById: jest.Mock;
    update: jest.Mock;
    createPendingChange: jest.Mock;
  };
  let personalizationService: { decideAction: jest.Mock };

  beforeEach(async () => {
    eventRepository = { createQueryBuilder: jest.fn(() => makeEventQb(null)) };
    eventService = {
      findById: jest.fn(),
      findByIds: jest.fn(),
      findInRange: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue([
        {
          id: 'evt-1',
          title: OPEN_TASK.title,
          eventType: 'planned_block',
          startTime: new Date(`${TODAY}T09:00:00.000Z`),
          endTime: new Date(`${TODAY}T09:30:00.000Z`),
        },
      ]),
      remove: jest.fn(),
      reschedule: jest.fn(),
    };
    taskService = {
      findById: jest.fn().mockResolvedValue(OPEN_TASK),
      update: jest.fn().mockResolvedValue({ ...OPEN_TASK, scheduledFor: TODAY }),
      createPendingChange: jest.fn(),
    };
    personalizationService = { decideAction: jest.fn() };

    const planningTime = {
      timezoneFor: jest.fn().mockResolvedValue('UTC'),
      today: jest.fn().mockResolvedValue(TODAY),
      localDate: jest.fn().mockResolvedValue(TODAY),
      toInstant: jest.fn(
        async (_ctx: unknown, date: string, wall: string) => new Date(`${date}T${wall}:00.000Z`),
      ),
    };

    const module = await Test.createTestingModule({
      providers: [
        PlannedBlockService,
        { provide: getRepositoryToken(EventEntity), useValue: eventRepository },
        { provide: EventService, useValue: eventService },
        { provide: TaskService, useValue: taskService },
        { provide: PlanningTimeService, useValue: planningTime },
        { provide: PersonalizationService, useValue: personalizationService },
        { provide: PersonService, useValue: { findById: jest.fn() } },
        { provide: UserContextService, useValue: { getSelfIdentity: jest.fn().mockResolvedValue(null) } },
        { provide: LoggerService, useValue: { setContext: jest.fn(), log: jest.fn(), debug: jest.fn() } },
      ],
    }).compile();

    service = module.get(PlannedBlockService);
  });

  it('user Schedule always places without consulting the trust dial', async () => {
    const outcome = await service.scheduleTask(CTX, OPEN_TASK.id);

    expect(personalizationService.decideAction).not.toHaveBeenCalled();
    expect(eventService.create).toHaveBeenCalledWith(
      CTX,
      expect.objectContaining({
        event_type: 'planned_block',
        task_id: OPEN_TASK.id,
        title: OPEN_TASK.title,
      }),
    );
    expect(outcome.status).toBe('placed');
  });

  it('automation review writes a pending schedule instead of placing', async () => {
    personalizationService.decideAction.mockResolvedValue('review');

    const outcome = await service.tryPlaceAfterOpen(CTX, OPEN_TASK as never, 0.8);

    expect(outcome.status).toBe('proposed');
    expect(eventService.create).not.toHaveBeenCalled();
    expect(taskService.createPendingChange).toHaveBeenCalledWith(
      CTX,
      expect.objectContaining({
        taskId: OPEN_TASK.id,
        kind: 'schedule',
      }),
    );
  });

  it('automation auto places into the next free gap', async () => {
    personalizationService.decideAction.mockResolvedValue('auto');

    const outcome = await service.tryPlaceAfterOpen(CTX, OPEN_TASK as never, 0.9);

    expect(personalizationService.decideAction).toHaveBeenCalledWith(CTX.userId, {
      kind: 'schedule_accept',
      confidence: 0.9,
      hasUserInput: false,
    });
    expect(outcome.status).toBe('placed');
    expect(eventService.create).toHaveBeenCalled();
  });

  // ═══ scheduleTaskAt — the calendar-drop path ═══
  //
  // `scheduleTask` only ever takes a preferred DATE and runs the gap solver.
  // A calendar drop computes an exact instant and used to be collapsed down to
  // that same date-only call, so the gap solver silently re-derived a
  // different time than the one under the cursor. These pin the method that
  // fixes it: the instant given is the instant placed at, full stop — no gap
  // search, no re-derivation.

  it('scheduleTaskAt places at the exact instant given, bypassing the gap solver entirely', async () => {
    const start = new Date(`${TODAY}T15:15:00.000Z`);
    const end = new Date(`${TODAY}T15:45:00.000Z`);

    const outcome = await service.scheduleTaskAt(CTX, OPEN_TASK.id, start, end);

    expect(outcome.status).toBe('placed');
    expect(eventService.create).toHaveBeenCalledWith(
      CTX,
      expect.objectContaining({
        task_id: OPEN_TASK.id,
        start_time: start,
        end_time: end,
      }),
    );
    // The gap solver reads occupancy via `findInRange` — proof nothing about
    // "is there room" was ever consulted for an explicit drop.
    expect(eventService.findInRange).not.toHaveBeenCalled();
  });

  it('scheduleTaskAt derives an end from the task’s own estimate when none is given', async () => {
    const start = new Date(`${TODAY}T15:15:00.000Z`);

    await service.scheduleTaskAt(CTX, OPEN_TASK.id, start);

    expect(eventService.create).toHaveBeenCalledWith(
      CTX,
      expect.objectContaining({
        start_time: start,
        // OPEN_TASK.estimatedMinutes is 30.
        end_time: new Date(start.getTime() + 30 * 60_000),
      }),
    );
  });

  it('scheduleTaskAt accepts a past instant rather than silently re-placing on today', async () => {
    const yesterday = new Date(new Date(`${TODAY}T15:15:00.000Z`).getTime() - 24 * 60 * 60 * 1000);

    const outcome = await service.scheduleTaskAt(CTX, OPEN_TASK.id, yesterday);

    expect(outcome.status).toBe('placed');
    expect(eventService.create).toHaveBeenCalledWith(
      CTX,
      expect.objectContaining({ start_time: yesterday }),
    );
  });

  it('scheduleTaskAt MOVES an already-placed task instead of reporting a silent no-op', async () => {
    const existingRow = { id: 'evt-existing' } as EventEntity;
    eventRepository.createQueryBuilder = jest.fn(() => makeEventQb(existingRow));
    eventService.findById.mockResolvedValue({ id: 'evt-existing', taskId: OPEN_TASK.id });

    const start = new Date(`${TODAY}T15:15:00.000Z`);
    const moved = { id: 'evt-existing', startTime: start };
    eventService.reschedule.mockResolvedValue(moved);

    const outcome = await service.scheduleTaskAt(CTX, OPEN_TASK.id, start);

    expect(eventService.reschedule).toHaveBeenCalledWith(CTX, 'evt-existing', start, undefined);
    expect(eventService.create).not.toHaveBeenCalled();
    expect(outcome.status).toBe('placed');
    expect('event' in outcome && outcome.event).toBe(moved);
  });

  it('scheduleTaskAt falls back to already_placed only if the move genuinely fails', async () => {
    const existingRow = { id: 'evt-existing' } as EventEntity;
    eventRepository.createQueryBuilder = jest.fn(() => makeEventQb(existingRow));
    eventService.findById.mockResolvedValue({ id: 'evt-existing', taskId: OPEN_TASK.id });
    eventService.reschedule.mockResolvedValue(null);

    const outcome = await service.scheduleTaskAt(CTX, OPEN_TASK.id, new Date(`${TODAY}T15:15:00.000Z`));

    expect(outcome.status).toBe('already_placed');
  });

  it('scheduleTaskAt refuses a done task the same way scheduleTask does', async () => {
    taskService.findById.mockResolvedValue({ ...OPEN_TASK, status: 'done' });

    const outcome = await service.scheduleTaskAt(CTX, OPEN_TASK.id, new Date(`${TODAY}T15:15:00.000Z`));

    expect(outcome.status).toBe('skipped');
    expect(eventService.create).not.toHaveBeenCalled();
  });

  it('automation skip leaves the task unscheduled', async () => {
    personalizationService.decideAction.mockResolvedValue('skip');

    const outcome = await service.tryPlaceAfterOpen(CTX, OPEN_TASK as never, 0.4);

    expect(outcome.status).toBe('skipped');
    expect(eventService.create).not.toHaveBeenCalled();
    expect(taskService.createPendingChange).not.toHaveBeenCalled();
  });
});
