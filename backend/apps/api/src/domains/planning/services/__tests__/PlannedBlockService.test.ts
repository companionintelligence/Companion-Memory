import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { humanSlotInTZ } from '@ci/common/time/zoned';
import { EventEntity, CalendarEventService, PersonService, UserContextService } from '@ci/domains/memory';
import { PersonalizationService } from '@ci/domains/personalization';

import { shiftLocalDate } from '../../engine/computePlacement';
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
const TOMORROW = shiftLocalDate(TODAY, 1);

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
      // Echoes the DTO back rather than answering with one canned row: a test
      // that reads `outcome.event` is otherwise asserting the fixture, not the
      // placement, and would keep passing if the solver handed `create` a
      // different slot than the one it reported.
      create: jest.fn(async (_ctx: unknown, dto: Record<string, unknown>) => [
        {
          id: 'evt-1',
          title: dto.title,
          eventType: dto.event_type,
          startTime: dto.start_time,
          endTime: dto.end_time,
          taskId: dto.task_id,
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
      wallTime: jest.fn(async (_ctx: unknown, instant: Date) => instant.toISOString().slice(11, 16)),
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

    // The event handed back is the one that was written. `create` echoes its
    // DTO, so this is a real link between the slot the solver chose and the
    // slot the caller is told about — it cannot pass against a canned row.
    const [, created] = eventService.create.mock.calls[0];

    expect(outcome.status === 'placed' && outcome.event.startTime).toEqual(created.start_time);
  });

  it('user Schedule stamps is_auto=false and a fresh last_moved_at', async () => {
    const before = Date.now();

    await service.scheduleTask(CTX, OPEN_TASK.id);

    const [, created] = eventService.create.mock.calls[0];

    expect(created.is_auto).toBe(false);
    expect(created.last_moved_at).toBeInstanceOf(Date);
    expect((created.last_moved_at as Date).getTime()).toBeGreaterThanOrEqual(before);
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

  // The rationale is the sentence on the Plan card. It used to be
  // "Place on the calendar at 2026-09-28T16:00:00.000Z?" — the UTC instant,
  // verbatim. It must read the slot on the owner's clock instead, while the
  // patch keeps the exact instant a Confirm replays.
  it('words the pending schedule in the owner’s zone, not as a raw ISO instant', async () => {
    personalizationService.decideAction.mockResolvedValue('review');
    (planningTimeMock.timezoneFor as jest.Mock).mockResolvedValue('America/New_York');

    await service.tryPlaceAfterOpen(CTX, OPEN_TASK as never, 0.8);

    const [, change] = taskService.createPendingChange.mock.calls[0];
    const start = new Date(change.patch.startTime);

    expect(change.rationale).toBe(`Place on the calendar on ${humanSlotInTZ(start, 'America/New_York')}?`);
    expect(change.rationale).not.toContain(change.patch.startTime);
    expect(change.rationale).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(planningTimeMock.timezoneFor).toHaveBeenCalledWith(CTX.userId);
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

    // Nobody clicked anything to get here — the trust dial decided this task
    // may be placed unattended, so the block must say so.
    const [, created] = eventService.create.mock.calls[0];

    expect(created.is_auto).toBe(true);
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

    // A drag is a human action.
    expect(eventService.create).toHaveBeenCalledWith(CTX, expect.objectContaining({ is_auto: false }));
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

    // `{ isAuto: false }`: a drag is a human placing this block right now,
    // regardless of whether it was previously auto-placed.
    expect(eventService.reschedule).toHaveBeenCalledWith(CTX, 'evt-existing', start, undefined, {
      isAuto: false,
    });
    expect(eventService.create).not.toHaveBeenCalled();
    expect(outcome.status).toBe('placed');
    expect('event' in outcome && outcome.event).toBe(moved);
  });

  // The move branch used to return the ORIGINAL task, so a card dragged to a
  // new day kept the old `scheduledFor`: the block sat on Thursday while the
  // Plan page filed the card under Overdue, and the stale past date later made
  // `planAsUnscheduled` strip the task's dueAt outright.
  it('scheduleTaskAt re-dates the task when it MOVES an existing block', async () => {
    const existingRow = { id: 'evt-existing' } as EventEntity;
    eventRepository.createQueryBuilder = jest.fn(() => makeEventQb(existingRow));
    eventService.findById.mockResolvedValue({ id: 'evt-existing', taskId: OPEN_TASK.id });

    const start = new Date(`${TOMORROW}T15:15:00.000Z`);
    eventService.reschedule.mockResolvedValue({ id: 'evt-existing', startTime: start });
    taskService.update.mockResolvedValue({ ...OPEN_TASK, scheduledFor: TOMORROW });

    const outcome = await service.scheduleTaskAt(CTX, OPEN_TASK.id, start);

    expect(taskService.update).toHaveBeenCalledWith(CTX, OPEN_TASK.id, { scheduledFor: TOMORROW });
    expect(outcome.status).toBe('placed');
    expect('task' in outcome && outcome.task?.scheduledFor).toBe(TOMORROW);
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

  // ═══ unschedule — the Undo of the whole feature ═══
  //
  // Two writes, and BOTH have to happen: the block comes off the calendar and
  // the task loses its date. Dropping the second leaves a task dated to a day
  // with nothing on it, which `sectionFor` files under Overdue — the same
  // confusion a calendar drag that forgets `scheduledFor` produces.

  it('unschedule removes the block and clears the task’s date', async () => {
    eventRepository.createQueryBuilder = jest.fn(() => makeEventQb({ id: 'evt-existing' } as EventEntity));
    eventService.findById.mockResolvedValue({ id: 'evt-existing', taskId: OPEN_TASK.id });
    taskService.update.mockResolvedValue({ ...OPEN_TASK, scheduledFor: null });

    const result = await service.unschedule(CTX, OPEN_TASK.id);

    expect(eventService.remove).toHaveBeenCalledWith(CTX, 'evt-existing');
    expect(taskService.update).toHaveBeenCalledWith(CTX, OPEN_TASK.id, { scheduledFor: null });
    expect(result?.scheduledFor).toBeNull();
  });

  // Unscheduling a task that never had a block is the ordinary case for work
  // dated by a scan rather than placed by the planner: nothing to remove, and
  // the date still has to go.
  it('unschedule is a safe no-op on a task with no block, and still clears the date', async () => {
    taskService.update.mockResolvedValue({ ...OPEN_TASK, scheduledFor: null });

    const result = await service.unschedule(CTX, OPEN_TASK.id);

    expect(eventService.remove).not.toHaveBeenCalled();
    expect(taskService.update).toHaveBeenCalledWith(CTX, OPEN_TASK.id, { scheduledFor: null });
    expect(result?.scheduledFor).toBeNull();
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

  // ═══ applyPendingSchedule — Accept on a suggestion that has been waiting ═══
  //
  // A `schedule` patch is written once, at task creation, and accepted whenever
  // the user gets to it. Replaying the stored instant blind booked blocks in
  // the past and stacked every proposal from one scan run on the same slot,
  // because filing a proposal reserves nothing and `propose` is deterministic
  // against an unchanged calendar. The stored slot now only survives while it
  // is still future and still free.

  function schedulePatch(start: Date, end: Date) {
    return { startTime: start.toISOString(), endTime: end.toISOString(), estimatedMinutes: 30 };
  }

  it('applyPendingSchedule honours a stored slot that is still future and free', async () => {
    const start = new Date(`${TOMORROW}T10:00:00.000Z`);
    const end = new Date(`${TOMORROW}T10:30:00.000Z`);

    const outcome = await service.applyPendingSchedule(CTX, OPEN_TASK.id, schedulePatch(start, end));

    expect(outcome.status).toBe('placed');
    expect(eventService.create).toHaveBeenCalledWith(
      CTX,
      expect.objectContaining({ start_time: start, end_time: end }),
    );

    // The AI computed WHERE (the stored slot came from `propose` back at
    // task-creation time), but a human just clicked Confirm — the trust-dial
    // `review` path exists precisely because the AI was not confident enough
    // to write this unattended, so the click is the placement decision.
    const [, created] = eventService.create.mock.calls[0];

    expect(created.is_auto).toBe(false);
  });

  it('applyPendingSchedule re-solves rather than booking a stored instant that is now past', async () => {
    const start = new Date(Date.now() - 26 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 30 * 60_000);
    const before = Date.now();

    const outcome = await service.applyPendingSchedule(CTX, OPEN_TASK.id, schedulePatch(start, end));

    expect(outcome.status).toBe('placed');

    const [, created] = eventService.create.mock.calls[0];

    // computePlacement clamps its cursor to `now`; the whole point of routing
    // back through the solver is that this can no longer land in the past.
    expect(created.start_time.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('applyPendingSchedule re-solves when something has taken the stored slot', async () => {
    const start = new Date(`${TOMORROW}T09:00:00.000Z`);
    const end = new Date(`${TOMORROW}T09:30:00.000Z`);

    // The meeting the user accepted after the suggestion was filed — and, in
    // the multi-proposal case, the block a sibling confirmation already placed.
    eventService.findInRange.mockResolvedValue([
      { startTime: start, endTime: end, isAllDay: false, plannedMinutes: null },
    ]);

    const outcome = await service.applyPendingSchedule(CTX, OPEN_TASK.id, schedulePatch(start, end));

    expect(outcome.status).toBe('placed');
    expect(eventService.create).toHaveBeenCalledWith(
      CTX,
      expect.objectContaining({ start_time: new Date(`${TOMORROW}T09:30:00.000Z`) }),
    );
  });

  it('applyPendingSchedule falls back to the solver for an unusable patch', async () => {
    const outcome = await service.applyPendingSchedule(CTX, OPEN_TASK.id, { startTime: 'not-a-date' });

    expect(outcome.status).toBe('placed');
    expect(eventService.create).toHaveBeenCalled();
  });

  // ═══ all-day rows are not occupied time ═══
  //
  // A holiday calendar, a birthday, or a week of PTO is stored midnight to
  // midnight. Treating one as busy covers the whole workday, so one row per day
  // made every task in the flex window return no_gap — permanently, explained
  // only by a logger.debug.

  function allDayRows(overrides: Record<string, unknown> = {}) {
    return Array.from({ length: PLANNING_PREFS_DEFAULTS.flexDays + 1 }, (_unused, day) => ({
      startTime: new Date(`${shiftLocalDate(TODAY, day)}T00:00:00.000Z`),
      endTime: new Date(`${shiftLocalDate(TODAY, day + 1)}T00:00:00.000Z`),
      isAllDay: true,
      plannedMinutes: null,
      ...overrides,
    }));
  }

  it('places straight through a flex window covered by all-day events', async () => {
    eventService.findInRange.mockResolvedValue(allDayRows());

    const outcome = await service.scheduleTask(CTX, OPEN_TASK.id);

    expect(outcome.status).toBe('placed');
  });

  // The `isAllDay` column is authority, but rows already in the database were
  // written without it being read back — so the midnight-to-midnight SHAPE has
  // to count too, or every existing PTO row keeps blocking the planner.
  it('recognises a legacy midnight-to-midnight row whose isAllDay flag reads false', async () => {
    eventService.findInRange.mockResolvedValue(allDayRows({ isAllDay: false }));

    const outcome = await service.scheduleTask(CTX, OPEN_TASK.id);

    expect(outcome.status).toBe('placed');
  });

  // The importer stores Google's bare `start.date` as UTC midnight whatever
  // zone the owner is in, so for anyone outside UTC an existing PTO row is not
  // owner-local-midnight-aligned — matching only the local wall clock would
  // leave every non-UTC user's calendar just as blocked as before.
  it('recognises a UTC-midnight all-day row for an owner in another zone', async () => {
    planningTimeMock.wallTime = jest.fn(async (_ctx: unknown, instant: Date) =>
      new Date(instant.getTime() - 4 * 60 * 60_000).toISOString().slice(11, 16),
    );
    eventService.findInRange.mockResolvedValue(allDayRows({ isAllDay: false }));

    const outcome = await service.scheduleTask(CTX, OPEN_TASK.id);

    expect(outcome.status).toBe('placed');
  });

  // The counterweight: this must not have become "ignore occupancy".
  it('still refuses a flex window whose every workday is genuinely booked', async () => {
    eventService.findInRange.mockResolvedValue(
      allDayRows().map((row) => ({
        ...row,
        isAllDay: false,
        startTime: new Date(row.startTime.getTime() + 60_000),
      })),
    );

    const outcome = await service.scheduleTask(CTX, OPEN_TASK.id);

    expect(outcome.status).toBe('no_gap');
  });

  // ═══ null-status blocks ═══
  //
  // `ci.events.status` is nullable, and `NULL NOT IN (...)` is UNKNOWN rather
  // than TRUE, so the bare predicate these readers used to carry silently
  // dropped every block whose status was never set.
  it('treats a block with no status as live in every planned-block read', async () => {
    const qb = makeEventQb({ id: 'evt-1', taskId: OPEN_TASK.id } as EventEntity);
    eventRepository.createQueryBuilder.mockReturnValue(qb);
    eventService.findById.mockResolvedValue({ id: 'evt-1', taskId: OPEN_TASK.id });
    eventService.findByIds.mockResolvedValue([{ id: 'evt-1', taskId: OPEN_TASK.id }]);

    await service.list(CTX, new Date(`${TODAY}T00:00:00.000Z`), new Date(`${TOMORROW}T00:00:00.000Z`));
    await service.findActiveForTask(CTX, OPEN_TASK.id);
    await service.listActiveTaskIds(CTX, [OPEN_TASK.id]);

    const statusPredicates = qb.andWhere.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes('cancelled'));

    expect(statusPredicates).toHaveLength(3);
    for (const sql of statusPredicates) {
      expect(sql).toBe("COALESCE(event.status, 'confirmed') NOT IN ('cancelled', 'no_show', 'skipped')");
    }
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
