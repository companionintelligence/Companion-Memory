import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventEntity, CalendarEventService, PersonService, UserContextService } from '@ci/domains/memory';
import { PersonalizationService } from '@ci/domains/personalization';

import { PLANNING_PREFS_DEFAULTS } from '../../entities/PlanningPrefsEntity';
import { PlannedBlockService } from '../PlannedBlockService';
import { PlanningPrefsService } from '../PlanningPrefsService';
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
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(row),
    getMany: jest.fn().mockResolvedValue(row ? [row] : []),
    getRawMany: jest.fn().mockResolvedValue(row?.taskId ? [{ taskId: row.taskId }] : []),
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
    update: jest.Mock;
  };
  let taskService: {
    findById: jest.Mock;
    update: jest.Mock;
    createPendingChange: jest.Mock;
    findPendingChanges: jest.Mock;
    declinePendingChange: jest.Mock;
    acceptProposed: jest.Mock;
  };
  let planningPrefs: { find: jest.Mock; resolve: jest.Mock };
  let planningTimeMock: { toInstant: jest.Mock; [k: string]: unknown };
  let userContextMock: { getSelfIdentity: jest.Mock };
  let personServiceMock: { findById: jest.Mock };
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
      update: jest.fn(),
    };
    taskService = {
      findById: jest.fn().mockResolvedValue(OPEN_TASK),
      update: jest.fn().mockResolvedValue({ ...OPEN_TASK, scheduledFor: TODAY }),
      createPendingChange: jest.fn(),
      findPendingChanges: jest.fn().mockResolvedValue([]),
      declinePendingChange: jest.fn(),
      acceptProposed: jest.fn(),
    };
    personalizationService = { decideAction: jest.fn() };

    const planningTime = {
      timezoneFor: jest.fn().mockResolvedValue('UTC'),
      today: jest.fn().mockResolvedValue(TODAY),
      localDate: jest.fn(async (_ctx: unknown, instant: Date) => instant.toISOString().slice(0, 10)),
      toInstant: jest.fn(
        async (_ctx: unknown, date: string, wall: string) => new Date(`${date}T${wall}:00.000Z`),
      ),
    };

    // No stored row: these cases assert the shipped-default workday, which is
    // what an appliance that has never opened a settings page uses.
    planningPrefs = {
      find: jest.fn().mockResolvedValue(null),
      resolve: jest.fn().mockResolvedValue({ ...PLANNING_PREFS_DEFAULTS }),
    };

    planningTimeMock = planningTime as never;
    userContextMock = { getSelfIdentity: jest.fn().mockResolvedValue(null) };
    personServiceMock = { findById: jest.fn().mockResolvedValue(null) };

    const module = await Test.createTestingModule({
      providers: [
        PlannedBlockService,
        { provide: getRepositoryToken(EventEntity), useValue: eventRepository },
        { provide: CalendarEventService, useValue: eventService },
        { provide: TaskService, useValue: taskService },
        { provide: PlanningTimeService, useValue: planningTime },
        { provide: PlanningPrefsService, useValue: planningPrefs },
        { provide: PersonalizationService, useValue: personalizationService },
        { provide: PersonService, useValue: personServiceMock },
        { provide: UserContextService, useValue: userContextMock },
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
    expect(eventService.create).toHaveBeenCalledWith(CTX, expect.objectContaining({ start_time: yesterday }));
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

  it('lists which of the given tasks already have a planned block', async () => {
    const qb = makeEventQb({ taskId: OPEN_TASK.id } as EventEntity);
    qb.getRawMany.mockResolvedValue([{ taskId: OPEN_TASK.id }]);
    eventRepository.createQueryBuilder.mockReturnValue(qb);

    await expect(service.listActiveTaskIds(CTX, [OPEN_TASK.id, 'other'])).resolves.toEqual(
      new Set([OPEN_TASK.id]),
    );
    await expect(service.listActiveTaskIds(CTX, [])).resolves.toEqual(new Set());
  });

  it('planAsUnscheduled declines a pending date, opens a proposal, and clears the block', async () => {
    taskService.findById.mockResolvedValue({ ...OPEN_TASK, status: 'proposed', scheduledFor: TODAY });
    taskService.findPendingChanges.mockResolvedValue([{ id: 'chg-1' }]);
    taskService.acceptProposed.mockResolvedValue({ ...OPEN_TASK, status: 'open' });
    taskService.update.mockResolvedValue({ ...OPEN_TASK, status: 'open', scheduledFor: null });
    eventRepository.createQueryBuilder = jest.fn(() => makeEventQb({ id: 'evt-existing' } as EventEntity));
    eventService.findById.mockResolvedValue({ id: 'evt-existing', taskId: OPEN_TASK.id });

    const result = await service.planAsUnscheduled(CTX, OPEN_TASK.id);

    expect(taskService.declinePendingChange).toHaveBeenCalledWith(CTX, 'chg-1');
    expect(taskService.acceptProposed).toHaveBeenCalledWith(CTX, OPEN_TASK.id);
    expect(eventService.remove).toHaveBeenCalledWith(CTX, 'evt-existing');
    expect(taskService.update).toHaveBeenCalledWith(CTX, OPEN_TASK.id, { scheduledFor: null });
    expect(result?.scheduledFor).toBeNull();
  });

  it('planAsUnscheduled strips a past proposed window so the task is undated', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const pastDue = new Date(`${yesterday}T12:00:00.000Z`);
    taskService.findById.mockResolvedValue({
      ...OPEN_TASK,
      status: 'proposed',
      scheduledFor: yesterday,
      dueAt: pastDue,
    });
    taskService.update.mockResolvedValue({
      ...OPEN_TASK,
      status: 'open',
      scheduledFor: null,
      dueAt: null,
    });

    const result = await service.planAsUnscheduled(CTX, OPEN_TASK.id);

    expect(taskService.acceptProposed).toHaveBeenCalledWith(CTX, OPEN_TASK.id);
    expect(taskService.update).toHaveBeenCalledWith(CTX, OPEN_TASK.id, {
      scheduledFor: null,
      dueAt: null,
    });
    expect(result?.scheduledFor).toBeNull();
    expect(result?.dueAt).toBeNull();
  });

  it('planAsUnscheduled on already-open work does not re-accept, only unschedules', async () => {
    taskService.findPendingChanges.mockResolvedValue([{ id: 'chg-2' }]);
    taskService.update.mockResolvedValue({ ...OPEN_TASK, scheduledFor: null });

    await service.planAsUnscheduled(CTX, OPEN_TASK.id);

    expect(taskService.acceptProposed).not.toHaveBeenCalled();
    expect(taskService.declinePendingChange).toHaveBeenCalledWith(CTX, 'chg-2');
    expect(taskService.update).toHaveBeenCalledWith(CTX, OPEN_TASK.id, { scheduledFor: null });
  });

  // ═══ applyPendingEventRevision — the Accept click on a cancellation ═══
  //
  // EventNowService only ever PROPOSES a cancellation; accepting it used to
  // apply nothing at all, because TaskService treated the patch as a task
  // patch and TypeORM silently dropped the event fields. The block stayed on
  // the calendar — the opposite of what Accept promised.

  const CANCEL_PATCH = { eventStatus: 'cancelled', eventId: 'evt-1' };

  function plannedBlock(overrides: Record<string, unknown> = {}) {
    return {
      id: 'evt-1',
      taskId: OPEN_TASK.id,
      eventType: 'planned_block',
      status: 'confirmed',
      ...overrides,
    };
  }

  it('cancels the linked planned block when an event_revise change is accepted', async () => {
    eventService.findById.mockResolvedValue(plannedBlock());
    eventService.update.mockImplementation(async (_ctx: unknown, id: string, data: { status: string }) =>
      plannedBlock({ id, status: data.status }),
    );

    const result = await service.applyPendingEventRevision(CTX, OPEN_TASK.id, CANCEL_PATCH);

    expect(eventService.update).toHaveBeenCalledWith(CTX, 'evt-1', { status: 'cancelled' });
    expect(result?.status).toBe('cancelled');
  });

  it('never names the generated duration_minutes column', async () => {
    // ci.events.duration_minutes is GENERATED ALWAYS — naming it in an UPDATE
    // is a hard Postgres error, not a silent no-op.
    eventService.findById.mockResolvedValue(plannedBlock());
    eventService.update.mockResolvedValue(plannedBlock({ status: 'cancelled' }));

    await service.applyPendingEventRevision(CTX, OPEN_TASK.id, CANCEL_PATCH);

    const [, , patch] = eventService.update.mock.calls[0];

    expect(Object.keys(patch)).toEqual(['status']);
  });

  it("refuses a patch pointing at another task's block", async () => {
    eventService.findById.mockResolvedValue(plannedBlock({ taskId: 'someone-elses-task' }));

    expect(await service.applyPendingEventRevision(CTX, OPEN_TASK.id, CANCEL_PATCH)).toBeNull();
    expect(eventService.update).not.toHaveBeenCalled();
  });

  it('refuses a status this pathway never proposes', async () => {
    eventService.findById.mockResolvedValue(plannedBlock());

    expect(
      await service.applyPendingEventRevision(CTX, OPEN_TASK.id, {
        ...CANCEL_PATCH,
        eventStatus: 'confirmed',
      }),
    ).toBeNull();
    expect(eventService.update).not.toHaveBeenCalled();
  });

  it('automation skip leaves the task unscheduled', async () => {
    personalizationService.decideAction.mockResolvedValue('skip');

    const outcome = await service.tryPlaceAfterOpen(CTX, OPEN_TASK as never, 0.4);

    expect(outcome.status).toBe('skipped');
    expect(eventService.create).not.toHaveBeenCalled();
    expect(taskService.createPendingChange).not.toHaveBeenCalled();
  });

  describe('PlannedBlockService workday resolution', () => {
    // ci.planning_prefs is the new home for the workday. It must win.
    it('uses the stored preference when there is one', async () => {
      planningPrefs.find.mockResolvedValue({
        userId: 'user-1',
        workStart: '07:00',
        workEnd: '15:00',
        defaultEstimatedMinutes: null,
        flexDays: null,
      });

      await service.scheduleTask(CTX, OPEN_TASK.id);

      expect(planningTimeMock.toInstant).toHaveBeenCalledWith(CTX, expect.any(String), '07:00');
      expect(planningTimeMock.toInstant).toHaveBeenCalledWith(CTX, expect.any(String), '15:00');
    });

    // The regression that matters for shipping this table: anyone who had already
    // set their hours through the self-Person jsonb leaf must keep them. Dropping
    // this fallback would silently reset those users to 09:00-17:00.
    it('falls back to the legacy self-Person leaf when no preference is stored', async () => {
      planningPrefs.find.mockResolvedValue(null);
      userContextMock.getSelfIdentity.mockResolvedValue({ entityId: 'person-1' });
      personServiceMock.findById.mockResolvedValue({
        properties: { schedule: { work_start: '06:30', work_end: '14:30' } },
      });

      await service.scheduleTask(CTX, OPEN_TASK.id);

      expect(planningTimeMock.toInstant).toHaveBeenCalledWith(CTX, expect.any(String), '06:30');
      expect(planningTimeMock.toInstant).toHaveBeenCalledWith(CTX, expect.any(String), '14:30');
    });

    it('uses the shipped default when neither a preference nor a legacy leaf exists', async () => {
      planningPrefs.find.mockResolvedValue(null);
      userContextMock.getSelfIdentity.mockResolvedValue(null);

      await service.scheduleTask(CTX, OPEN_TASK.id);

      expect(planningTimeMock.toInstant).toHaveBeenCalledWith(CTX, expect.any(String), '09:00');
      expect(planningTimeMock.toInstant).toHaveBeenCalledWith(CTX, expect.any(String), '17:00');
    });
  });
});
