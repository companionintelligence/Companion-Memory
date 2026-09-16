import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { EventEntity } from '@ci/domains/memory';

import { ReminderEntity, type Reminder } from '../entities/ReminderEntity';
import { TaskEntity } from '../entities/TaskEntity';

export interface CreateReminderDto {
  taskId?: string | null;
  blockId?: string | null;
  fireAt: Date;
}

/**
 * Manual reminder CRUD — mirrors CI-Planning's `createReminderChecked` /
 * `cancelReminderChecked` / `listReminders` (`services/notifications.ts`).
 *
 * Deliberately narrower than the source in two ways, both called out in the
 * PR description:
 *   1. `fireAt` must be an explicit instant. CI-Planning also accepts a
 *      `date`+`time` pair resolved via `zonedWallTimeToUTC`; that path adds a
 *      timezone dependency this milestone does not need to take on, since a
 *      client can resolve the owner's local time to an instant itself before
 *      calling this.
 *   2. No auto-derivation (`syncTaskReminders`) and no Focus Ritual cues —
 *      both out of scope for this milestone; see the migration's header
 *      comment. Every reminder created here has `source = 'manual'`.
 */
@Injectable()
export class ReminderService {
  constructor(
    @InjectRepository(ReminderEntity)
    private readonly reminderRepository: Repository<ReminderEntity>,
    @InjectRepository(TaskEntity)
    private readonly taskRepository: Repository<TaskEntity>,
    @InjectRepository(EventEntity)
    private readonly eventRepository: Repository<EventEntity>,
  ) {}

  async create(context: UserServiceContext, dto: CreateReminderDto): Promise<Reminder> {
    const hasTask = dto.taskId != null;
    const hasBlock = dto.blockId != null;

    if (hasTask === hasBlock) {
      throw new BadRequestException('Exactly one of `taskId` or `blockId` must be set');
    }

    // Folded into the same "not found" error as "doesn't exist" — a
    // cross-user probe cannot distinguish the two, matching CI-Planning's
    // createReminderChecked (services/notifications.ts).
    if (hasTask) {
      const owns = await this.taskRepository.exists({ where: { id: dto.taskId!, userId: context.userId } });

      if (!owns) {
        throw new NotFoundException('Task not found');
      }
    } else {
      // Restricted to planned blocks, not any calendar event this user owns:
      // reminders are a planning-domain feature and `ci.events` also holds
      // imported/captured rows this feature was never designed against.
      const owns = await this.eventRepository.exists({
        where: { id: dto.blockId!, userId: context.userId, eventType: 'planned_block' },
      });

      if (!owns) {
        throw new NotFoundException('Planned block not found');
      }
    }

    const entity = this.reminderRepository.create({
      id: uuidv7(),
      userId: context.userId,
      taskId: dto.taskId ?? null,
      blockId: dto.blockId ?? null,
      fireAt: dto.fireAt,
      status: 'pending',
      firedAt: null,
      source: 'manual',
    });

    return this.reminderRepository.save(entity);
  }

  /** Soft: the row survives with `status = 'cancelled'`, off the dispatcher and off `listForUser`. */
  async cancel(context: UserServiceContext, id: string): Promise<Reminder | null> {
    const result = await this.reminderRepository.update(
      { id, userId: context.userId, status: Not('cancelled') },
      { status: 'cancelled' },
    );

    if ((result.affected ?? 0) === 0) {
      return null;
    }

    return this.reminderRepository.findOne({ where: { id, userId: context.userId } });
  }

  /** Everything not soft-cancelled, ordered like CI-Planning's `listReminders`. */
  async listForUser(context: UserServiceContext): Promise<Reminder[]> {
    return this.reminderRepository.find({
      where: { userId: context.userId, status: Not('cancelled') },
      order: { fireAt: 'ASC' },
    });
  }

  async findById(context: UserServiceContext, id: string): Promise<Reminder | null> {
    return this.reminderRepository.findOne({ where: { id, userId: context.userId } });
  }
}
