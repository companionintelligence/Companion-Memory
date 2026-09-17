import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Not } from 'typeorm';

import { ReminderService } from '../ReminderService';
import type { TaskService } from '../TaskService';

const CTX = { userId: 'user-1' } as never;
const FIRE_AT = new Date('2026-09-20T09:00:00.000Z');

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
