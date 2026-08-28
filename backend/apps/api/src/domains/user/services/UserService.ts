import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import bcrypt from 'bcrypt';
import { QueryDeepPartialEntity, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { ServiceContext, SYSTEM_USER } from '@ci/common/context';
import config from '@ci/configuration';
import { EventService } from '@ci/domains/events';

import { type User, UserEntity } from '../entities/UserEntity';
import { UserCreatedEvent, UserUpdatedEvent, UserRemovedEvent } from '../events';
import { CreateUserDto, UpdateUserDto } from '../types';

/**
 * Grace period between "delete my account" and the irreversible purge of the data.
 * Stamped onto the row when deletion is requested, so changing this value never moves
 * a deadline already promised to someone who has left.
 *
 * Now a real schedule rather than a promise: `AccountPurgeService` reads `purgeAfter`
 * and destroys the data once it passes.
 */
const purgeGraceDays = () => config.accountDeletion.graceDays;

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly eventService: EventService,
  ) {}

  async create(context: ServiceContext, data: CreateUserDto): Promise<User> {
    if (context.userId !== SYSTEM_USER) {
      throw new Error('Unauthorized');
    }

    const id = data.id ?? uuidv7();
    const hashedPassword = await bcrypt.hash(data.password, config.auth.local.saltRounds);

    const instance = this.userRepository.create({
      ...data,
      id,
      password: hashedPassword,
    });

    const entity = await this.userRepository.save(instance);

    await this.eventService.send(UserCreatedEvent, {
      userId: entity.id,
    });

    return UserEntity.toEgressType(entity);
  }

  async findAll(): Promise<User[]> {
    const result = await this.userRepository.find();

    return result.map((entity) => UserEntity.toEgressType(entity));
  }

  /**
   * The audience for recurring per-user background work — the same population
   * `PythonFunctionCrons` selects with `SELECT id FROM ci.users WHERE onboarded
   * = true`. An account that never finished FTUE has no connections, no corpus
   * and no timezone the user chose, so every job fanned out to it can only
   * no-op; `findAll()` includes those rows and is the wrong list to fan out on.
   */
  async findAllOnboarded(): Promise<User[]> {
    const result = await this.userRepository.find({ where: { onboarded: true } });

    return result.map((entity) => UserEntity.toEgressType(entity));
  }

  async findById(context: ServiceContext, id: string): Promise<User | null> {
    if (context.userId !== SYSTEM_USER && context.userId !== id) {
      throw new UnauthorizedException();
    }

    const result = await this.userRepository.findOne({
      where: {
        id,
      },
    });

    return result ? UserEntity.toEgressType(result) : null;
  }

  async update(context: ServiceContext, id: string, data: UpdateUserDto): Promise<User | null> {
    if (context.userId !== SYSTEM_USER && context.userId !== id) {
      throw new UnauthorizedException();
    }

    await this.userRepository.update(id, data as QueryDeepPartialEntity<UserEntity>);

    await this.eventService.send(UserUpdatedEvent, {
      userId: id,
    });

    return this.findById(context, id);
  }

  /**
   * Request account deletion — the in-app path App Store Guideline 5.1.1(v) and
   * Google Play's Data Deletion policy require of any app that offers in-app signup.
   *
   * Access dies here, data dies later. Stamping `deletedAt` is the whole access
   * revocation: `@DeleteDateColumn` makes every read on this repository skip the row,
   * so login, JWT, API-key and OIDC resolution all start failing on the next request
   * without any of them knowing this feature exists. The rows themselves are removed
   * afterwards by `AccountPurgeService`, no earlier than `purgeAfter` — a hard delete
   * here would raise a foreign-key violation anyway (eighteen constraints reference
   * users(id) with no ON DELETE action; see the migration).
   *
   * Idempotent: a second request finds nothing (the first one hid the row) and
   * returns false rather than throwing.
   */
  async requestDeletion(context: ServiceContext, id: string): Promise<boolean> {
    if (context.userId !== SYSTEM_USER && context.userId !== id) {
      throw new UnauthorizedException();
    }

    const existing = await this.findById(context, id);

    if (!existing) {
      return false;
    }

    const purgeAfter = new Date(Date.now() + purgeGraceDays() * 24 * 60 * 60 * 1000);

    // One write, not `softDelete()` then `update()`: the access gate (`deletedAt`) and
    // the promise about when the data goes (`purgeAfter`) must never exist apart.
    await this.userRepository.update(id, { deletedAt: new Date(), purgeAfter });

    await this.eventService.send(UserRemovedEvent, {
      userId: id,
    });

    return true;
  }

  /**
   * Hard-delete a user row.
   *
   * ⚠️ This is not the account-deletion path — use {@link requestDeletion}, and see
   * `AccountPurgeService` for the hard delete. It cannot succeed for any account that
   * has stored anything: eighteen constraints reference users(id) with no ON DELETE
   * action, so Postgres raises a foreign-key violation. It survives only because
   * nothing calls it.
   */
  async remove(context: ServiceContext, id: string): Promise<boolean> {
    if (context.userId !== SYSTEM_USER && context.userId !== id) {
      throw new UnauthorizedException();
    }

    // `await` matters: without it this is a Promise, which is always truthy, so the
    // guard below never fired and `remove()` always reached the DELETE — firing a
    // spurious UserRemovedEvent for an id that does not exist.
    const existingUser = await this.findById(context, id);

    if (!existingUser) {
      return false;
    }

    await this.userRepository.delete(id);

    await this.eventService.send(UserRemovedEvent, {
      userId: id,
    });

    return true;
  }

  async validatePassword(email: string, password: string): Promise<User | null> {
    const result = await this.userRepository.findOne({
      where: {
        email,
      },
    });

    if (result == null) {
      return null;
    }

    const validCredentials = await bcrypt.compare(password, result.password);

    if (!validCredentials) {
      return null;
    }

    return UserEntity.toEgressType(result);
  }

  /**
   * Change the authenticated user's own email. Callers must have already
   * verified `checkEmailAvailability` and, for non-federated accounts,
   * re-authenticated with the current password — this method just writes.
   */
  async changeEmail(context: ServiceContext, id: string, newEmail: string): Promise<User | null> {
    if (context.userId !== SYSTEM_USER && context.userId !== id) {
      throw new UnauthorizedException();
    }

    await this.userRepository.update(id, { email: newEmail });

    await this.eventService.send(UserUpdatedEvent, {
      userId: id,
    });

    return this.findById(context, id);
  }

  /**
   * Change the authenticated user's own password. Unlike {@link update}, this
   * hashes the plaintext before writing — `update()` persists `password`
   * verbatim, so passing a raw password through it would store it unhashed.
   */
  async changePassword(context: ServiceContext, id: string, newPassword: string): Promise<void> {
    if (context.userId !== SYSTEM_USER && context.userId !== id) {
      throw new UnauthorizedException();
    }

    const hashedPassword = await bcrypt.hash(newPassword, config.auth.local.saltRounds);

    await this.userRepository.update(id, { password: hashedPassword });

    await this.eventService.send(UserUpdatedEvent, {
      userId: id,
    });
  }

  async checkEmailAvailability(email: string): Promise<boolean> {
    const result = await this.userRepository.findOne({
      where: {
        email,
      },
      // Must see soft-deleted rows. They keep their address — ci.users.email is UNIQUE
      // across them — so an INSERT would still collide. Reading through the default
      // filter would report a deleted user's address as free and signup would get a
      // raw constraint violation instead of "email already registered".
      withDeleted: true,
    });

    return !!result;
  }

  async findByEmail(email: string): Promise<User | null> {
    const result = await this.userRepository.findOne({
      where: {
        email,
      },
    });

    return result ? UserEntity.toEgressType(result) : null;
  }

  async onboard(id: string): Promise<void> {
    await this.userRepository.update(id, {
      onboarded: true,
      onboardedAt: new Date(),
    });
  }

  /**
   * Users who finished FTUE at least `minAgeMs` ago and have never received
   * actions-system seed cards. Used by the deferred initializer cron.
   */
  async listUsersReadyForInitialActions(minAgeMs: number, limit: number = 50): Promise<string[]> {
    const cutoff = new Date(Date.now() - minAgeMs);

    const rows = await this.userRepository
      .createQueryBuilder('user')
      .select('user.id', 'id')
      .where('user.onboarded = TRUE')
      .andWhere('user.onboardedAt IS NOT NULL')
      .andWhere('user.onboardedAt <= :cutoff', { cutoff })
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM ci.actions action
          WHERE action.user_id = "user".id
        )`,
      )
      .orderBy('user.onboardedAt', 'ASC')
      .limit(limit)
      .getRawMany<{ id: string }>();

    return rows.map((row) => row.id);
  }
}
