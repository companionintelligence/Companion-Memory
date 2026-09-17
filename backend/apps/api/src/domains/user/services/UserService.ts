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

/**
 * Advisory-lock key serializing the "is this appliance unowned?" check in
 * {@link UserService.claimApplianceIfUnowned}.
 *
 * Any stable bigint works. This one is the version of the migration that heals the appliances
 * predating that method (20260910133657_bootstrap_first_user_as_admin) — arbitrary, but unique by
 * construction and traceable to what it guards, so a future advisory lock in another domain can be
 * chosen not to collide with it.
 */
const APPLIANCE_CLAIM_LOCK_KEY = 20260910133657;

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

    // Before the event, so nothing observing UserCreated can read a half-claimed appliance.
    entity.role = (await this.claimApplianceIfUnowned(entity.id)) ? 'admin' : entity.role;

    await this.eventService.send(UserCreatedEvent, {
      userId: entity.id,
    });

    return UserEntity.toEgressType(entity);
  }

  /**
   * Makes the account that claims an unowned appliance its administrator.
   *
   * ── Why this exists ────────────────────────────────────────────────────────
   *
   * Until this method, NOTHING in application code ever wrote `role = 'admin'`. The only path was
   * migration 20260825233952, which promotes the earliest EXISTING user and only when no admin
   * exists: on an upgrade that finds the owner, but on a fresh install it runs against an empty
   * `ci.users`, matches nothing, and the first signup lands on the column default `'user'`. Every
   * appliance installed fresh was therefore permanently admin-less, which made
   * {@link AdminOnlyGuard}'s routes — all MCP server configuration including the outbound
   * per-tool approval UI, and `GET /api/tools/invocations/system`, the only reader of the ledger's
   * `user_id IS NULL` rows — return 403 to every real user. Migration 20260910133657 heals the
   * appliances that already exist; this covers every one created from here on.
   *
   * ── Why the FIRST account, and why automatically ───────────────────────────
   *
   * Because on a single-owner personal appliance "admin" is not a distinct person from "the
   * owner", and this codebase already says so in three places that predate this method:
   * `SignupController.isSignupCodeRequired` exempts the first account precisely because "an
   * appliance with zero accounts has nothing to protect yet"; 20260825233952 identifies the owner
   * as `ORDER BY created_at ASC LIMIT 1`; and {@link findAllOnboarded} attributes an
   * appliance-wide connector's corpus to the first onboarded account, calling oldest-first "the
   * only stable meaning 'first account' can have". Promoting the first account is not a new
   * concept — it is the one already written down, finally applied.
   *
   * ── Why this TIGHTENS the appliance rather than loosening it ───────────────
   *
   * The instinct is that granting admin can only widen access. Here it does the opposite on net,
   * because {@link ApplianceAdminGuard} — which gates the `/jobs` appliance-wide controls and
   * `/signup-codes` minting — admits EVERY signed-in user when no admin exists, that being the
   * only honest thing it could do while the role was ungrantable. So on a fresh appliance today:
   * those routes are open to anyone with an account, and `AdminOnlyGuard`'s are open to nobody.
   * After this, the first surface narrows from everyone to one person and the second widens from
   * nobody to that same person. One hole closes; one route becomes usable by its intended reader.
   *
   * ── The unowned test, and why it matches the guard's exactly ───────────────
   *
   * "No LIVE admin" (`deleted_at IS NULL`), which is character-for-character the question
   * `ApplianceAdminGuard.applianceHasAdmin()` asks. They must agree: an appliance the guard treats
   * as unclaimed — and therefore opens to everybody — has to be one this is willing to claim, or
   * the permissive branch becomes permanent instead of transitional. A consequence worth stating
   * plainly: if the sole owner deletes their account, the next account created claims the box.
   * That is deliberate and is strictly better than the alternative, which is an appliance whose
   * control plane stays open to everyone forever.
   *
   * @returns whether this account was promoted.
   */
  private async claimApplianceIfUnowned(userId: string): Promise<boolean> {
    // One statement, inside a transaction holding an advisory lock, because the decision reads a
    // table it is about to write. Two signups racing on a fresh appliance would otherwise both
    // observe "no admin" under READ COMMITTED and both promote — a small consequence (two admins
    // on a single-owner box, both among its first two accounts) but a silent one, and the lock
    // costs nothing on a path that runs once per account.
    return this.userRepository.manager.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1)', [APPLIANCE_CLAIM_LOCK_KEY]);

      const promoted = await manager.query<Array<{ id: string }>>(
        `UPDATE ci.users
            SET role = 'admin'
          WHERE id = $1
            AND NOT EXISTS (
              SELECT 1 FROM ci.users WHERE role = 'admin' AND deleted_at IS NULL
            )
        RETURNING id`,
        [userId],
      );

      return promoted.length > 0;
    });
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
    // Ordered, because one caller reads position rather than the whole list:
    // `BlueBubblesSyncService` attributes an appliance-wide connector's corpus
    // to the FIRST onboarded account. Postgres row order is unspecified without
    // an ORDER BY, so on a two-account appliance consecutive syncs could file
    // the same messages under different users. Oldest-first is also the only
    // stable meaning "first account" can have.
    const result = await this.userRepository.find({
      where: { onboarded: true },
      order: { createdAt: 'ASC' },
    });

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

  /**
   * Whether this appliance has never been claimed — no account has ever been
   * created on it.
   *
   * Counts soft-deleted rows for the same reason `checkEmailAvailability` reads
   * through the filter: a deleted account still means someone claimed this box,
   * and re-opening signup for whoever reaches it next would be a way back in.
   */
  async hasNoUsers(): Promise<boolean> {
    const count = await this.userRepository.count({ withDeleted: true });

    return count === 0;
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
