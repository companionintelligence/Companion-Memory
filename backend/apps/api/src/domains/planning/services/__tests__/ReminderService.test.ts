import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Not } from 'typeorm';

import { ReminderService } from '../ReminderService';
import type { TaskService } from '../TaskService';

const CTX = { userId: 'user-1' } as never;
const FIRE_AT = new Date(Date.now() + 24 * 60 * 60_000);

function makeService({ task = { id: 'task-1' } as unknown, blockExists = true } = {}) {
  const reminderRepository = {
    create: jest.fn((row: Record<string, unknown>) => row),
    save: jest.fn((row: Record<string, unknown>) => Promise.resolve(row)),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    findOne: jest.fn().mockResolvedValue({ id: 'reminder-1', status: 'cancelled' }),
    find: jest.fn().mockResolvedValue([]),
  };
  const taskService = { findById: jest.fn().mockResolvedValue(task) } as unknown as jest.Mocked<TaskService>;
  const eventRepository = { exists: jest.fn().mockResolvedValue(blockExists) };

  const service = new ReminderService(reminderRepository as never, taskService, eventRepository as never);

  return { service, reminderRepository, taskService, eventRepository };
}

describe('ReminderService.create', () => {
  it.each([
    ['neither', {}],
    ['both', { taskId: 'task-1', blockId: 'block-1' }],
  ])('rejects %s of taskId/blockId', async (_label, target) => {
    const { service, reminderRepository } = makeService();

    await expect(service.create(CTX, { ...target, fireAt: FIRE_AT })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(reminderRepository.save).not.toHaveBeenCalled();
  });

  // The GraphQL resolver rejects a past `fireAt` too, but the service is the
  // boundary every caller goes through, so it holds the rule itself.
  it.each([
    ['in the past', new Date(Date.now() - 60_000)],
    ['not a valid date', new Date('not a date')],
  ])('rejects a fire time %s', async (_label, fireAt) => {
    const { service, reminderRepository } = makeService();

    await expect(service.create(CTX, { taskId: 'task-1', fireAt })).rejects.toThrow(
      new BadRequestException('Choose a reminder time in the future'),
    );
    expect(reminderRepository.save).not.toHaveBeenCalled();
  });

  it('defaults to push delivery and starts with no attempts', async () => {
    const { service } = makeService();

    const reminder = await service.create(CTX, { taskId: 'task-1', fireAt: FIRE_AT });

    expect(reminder).toEqual(
      expect.objectContaining({ deliveryMode: 'push', attempts: 0, nextAttemptAt: null, lastError: null }),
    );
  });

  it('keeps device delivery when the phone will schedule the reminder', async () => {
    const { service } = makeService();

    const reminder = await service.create(CTX, { taskId: 'task-1', fireAt: FIRE_AT, deliveryMode: 'device' });

    expect(reminder).toEqual(expect.objectContaining({ deliveryMode: 'device', status: 'pending' }));
  });

  it('creates a pending manual reminder for a task the caller owns', async () => {
    const { service, taskService } = makeService();

    const reminder = await service.create(CTX, { taskId: 'task-1', fireAt: FIRE_AT });

    expect(taskService.findById).toHaveBeenCalledWith(CTX, 'task-1');
    expect(reminder).toEqual(
      expect.objectContaining({
        userId: 'user-1',
        taskId: 'task-1',
        blockId: null,
        fireAt: FIRE_AT,
        status: 'pending',
        firedAt: null,
        source: 'manual',
      }),
    );
    expect(reminder.id).toEqual(expect.any(String));
  });

  // TaskService.findById is user-scoped, so another user's task comes back
  // null and is indistinguishable from one that doesn't exist.
  it('reports a task the caller cannot see as not found', async () => {
    const { service, reminderRepository } = makeService({ task: null });

    await expect(service.create(CTX, { taskId: 'someone-elses', fireAt: FIRE_AT })).rejects.toThrow(
      new NotFoundException('Task not found'),
    );
    expect(reminderRepository.save).not.toHaveBeenCalled();
  });

  it('creates a reminder for a planned block the caller owns', async () => {
    const { service, eventRepository, taskService } = makeService();

    const reminder = await service.create(CTX, { blockId: 'block-1', fireAt: FIRE_AT });

    expect(eventRepository.exists).toHaveBeenCalledWith({
      where: { id: 'block-1', userId: 'user-1', eventType: 'planned_block' },
    });
    expect(taskService.findById).not.toHaveBeenCalled();
    expect(reminder).toEqual(expect.objectContaining({ taskId: null, blockId: 'block-1' }));
  });

  it('reports a missing or non-planned block as not found', async () => {
    const { service, reminderRepository } = makeService({ blockExists: false });

    await expect(service.create(CTX, { blockId: 'imported-event', fireAt: FIRE_AT })).rejects.toThrow(
      new NotFoundException('Planned block not found'),
    );
    expect(reminderRepository.save).not.toHaveBeenCalled();
  });
});

describe('ReminderService.cancel', () => {
  it('soft-cancels an owned, not-yet-cancelled reminder and returns the row', async () => {
    const { service, reminderRepository } = makeService();

    await expect(service.cancel(CTX, 'reminder-1')).resolves.toEqual({
      id: 'reminder-1',
      status: 'cancelled',
    });
    expect(reminderRepository.update).toHaveBeenCalledWith(
      { id: 'reminder-1', userId: 'user-1', status: Not('cancelled') },
      { status: 'cancelled' },
    );
  });

  it('returns null when nothing matched (unknown, foreign, or already cancelled)', async () => {
    const { service, reminderRepository } = makeService();
    reminderRepository.update.mockResolvedValue({ affected: 0 });

    await expect(service.cancel(CTX, 'reminder-1')).resolves.toBeNull();
    expect(reminderRepository.findOne).not.toHaveBeenCalled();
  });
});

describe('ReminderService reads', () => {
  it('lists the caller’s non-cancelled reminders by fire time', async () => {
    const { service, reminderRepository } = makeService();

    await service.listForUser(CTX);

    expect(reminderRepository.find).toHaveBeenCalledWith({
      where: { userId: 'user-1', status: Not('cancelled') },
      order: { fireAt: 'ASC' },
    });
  });

  it('scopes findById to the caller', async () => {
    const { service, reminderRepository } = makeService();

    await service.findById(CTX, 'reminder-1');

    expect(reminderRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'reminder-1', userId: 'user-1' },
    });
  });
});

describe('ReminderService delivery state', () => {
  it('re-arms only a failed reminder the caller owns, clearing its attempts', async () => {
    const { service, reminderRepository } = makeService();

    await service.retry(CTX, 'reminder-1');

    expect(reminderRepository.update).toHaveBeenCalledWith(
      { id: 'reminder-1', userId: 'user-1', status: 'failed' },
      { status: 'pending', attempts: 0, claimedAt: null, nextAttemptAt: null, lastError: null },
    );
  });

  it('returns null from retry when the reminder is not failed', async () => {
    const { service, reminderRepository } = makeService();
    reminderRepository.update.mockResolvedValue({ affected: 0 });

    await expect(service.retry(CTX, 'reminder-1')).resolves.toBeNull();
  });

  it('confirms a device schedule only for a pending device-mode reminder', async () => {
    const { service, reminderRepository } = makeService();

    await service.confirmDeviceSchedule(CTX, 'reminder-1');

    expect(reminderRepository.update).toHaveBeenCalledWith(
      { id: 'reminder-1', userId: 'user-1', deliveryMode: 'device', status: 'pending' },
      { status: 'scheduled', lastError: null },
    );
  });
});
