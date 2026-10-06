import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import bcrypt from 'bcrypt';
import { EntityManager, QueryDeepPartialEntity, Repository } from 'typeorm';
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
 * Advisory-lock key serializing every account creation, and with it the two questions asked while
 * one is created: "is this the first account?" ({@link UserService.createFirstAccount}) and "is this
 * appliance unowned?" ({@link UserService.claimApplianceIfUnowned}).
 *
 * Any stable bigint works. This one is the version of the migration that heals the appliances
 * predating that method (20260910133657_bootstrap_first_user_as_admin) — arbitrary, but unique by
 * construction and traceable to what it guards, so a future advisory lock in another domain can be
 * chosen not to collide with it.
 */
const APPLIANCE_CLAIM_LOCK_KEY = 20260910133657;

/**
 * Work that must commit or roll back together with a new account, run inside the transaction that
 * creates it — after the row and its admin claim are written, before either is visible to anyone.
 * Write through `manager`; anything written another way is outside the transaction.
 */
export type WithNewAccount = (manager: EntityManager, user: User) => Promise<unknown>;

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly eventService: EventService,
  ) {}

  /**
   * @param alongside work the account must not exist without — redeeming the invitation that
   *   admitted it (`SignupCodeService.consume`), or the Hub forward-auth bridge's binding of the Hub
   *   person it is created for — run in the transaction that inserts the row. If it throws, the
   *   account is rolled back and its error reaches the caller as thrown.
   */
  async create(context: ServiceContext, data: CreateUserDto, alongside?: WithNewAccount): Promise<User> {
    if (context.userId !== SYSTEM_USER) {
      throw new Error('Unauthorized');
    }

    const user = await this.insertAccount(data, { onlyIfFirst: false, alongside });

    // Unreachable: only an `onlyIfFirst` insert can decline. Thrown rather than asserted away, so a
    // change that breaks that is a loud failure instead of a `null` typed as a User.
    if (user == null) {
      throw new Error('UserService.create: the account was not created');
    }

    return user;
  }

  /**
   * Create `data` as this appliance's FIRST account — or, if it already has one, create nothing and
   * return `null`.
   *
   * ── Why this is one step ───────────────────────────────────────────────────
   *
   * Three doors admit someone WITHOUT an invitation, and only while the appliance has never had an
   * account, because until then there is nobody who could have issued one: a Portal identity nobody
   * here has bound (`PortalTokenService.provisionUser`), the signup-code exemption
   * (`SignupController`), and an uninvited OIDC sign-in (`OidcController`). Each used to ask
   * {@link hasNoUsers} and then call {@link create} as a separate step. Two sign-ins arriving
   * together on an empty appliance both saw it empty and both got in, and whichever lost the race
   * for admin became a permanent member that nobody invited. Here the question is asked again inside
   * the transaction that inserts the row, under the lock every account creation takes, so exactly
   * one account can ever be first — and that account is the one {@link claimApplianceIfUnowned}
   * promotes, in the same transaction.
   *
   * ── What "first" means ─────────────────────────────────────────────────────
   *
   * No row in `ci.users` at all — soft-deleted ones included, the same question {@link hasNoUsers}
   * answers, and deliberately NOT the one the admin claim asks. An account awaiting its purge still
   * means someone claimed this box, and its data is still on disk; reopening uninvited signup while
   * it is there would be a way back in. Once the purge removes the last row the appliance is as
   * empty as a fresh install, and is claimable again. The admin claim is different on purpose: it
   * ignores deleted accounts, so an owner who deleted theirs is replaced as admin by the next account
   * created — through a door that still requires an invitation.
   *
   * @param alongside the caller's record of the claim — a federated binding — written in the same
   *   transaction. It then exists exactly when the account does, and a racer that lost finds both
   *   committed. If it throws, the account is rolled back with it.
   */
  async createFirstAccount(
    context: ServiceContext,
    data: CreateUserDto,
    alongside?: WithNewAccount,
  ): Promise<User | null> {
    if (context.userId !== SYSTEM_USER) {
      throw new Error('Unauthorized');
    }

    // The unlocked answer first. On a claimed appliance (the steady state, and where every repeat
    // first-account sign-in ends up) this declines without hashing a password or queueing on the
    // lock. Only an appliance that looked empty a moment ago pays for the real decision.
    if (!(await this.hasNoUsers())) {
      return null;
    }

    return this.insertAccount(data, { onlyIfFirst: true, alongside });
  }

  /**
   * Insert the account and settle its role, in one transaction holding {@link APPLIANCE_CLAIM_LOCK_KEY}.
   *
   * EVERY account creation takes the lock, not only the first-account ones. Both questions asked
   * here read the table they are about to write, and under READ COMMITTED an answer is only as good
   * as the guarantee that nobody inserts between the read and this transaction's commit — which
   * holds only if everybody who inserts waits on the same lock. It costs nothing on a path that runs
   * once per account.
   *
   * @returns `null` only when `onlyIfFirst` and the appliance already has an account.
   */
  private async insertAccount(
    data: CreateUserDto,
    { onlyIfFirst, alongside }: { onlyIfFirst: boolean; alongside?: WithNewAccount },
  ): Promise<User | null> {
    const id = data.id ?? uuidv7();
    const { passwordChosenByUser = true, ...columns } = data;
    // Before the transaction opens: bcrypt is the slow part, and nobody queued on the lock should
    // wait for it as well.
    const hashedPassword = await bcrypt.hash(data.password, config.auth.local.saltRounds);

    const instance = this.userRepository.create({
      ...columns,
      id,
      password: hashedPassword,
      passwordSetAt: passwordChosenByUser ? new Date() : null,
    });

    const entity = await this.userRepository.manager.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1)', [APPLIANCE_CLAIM_LOCK_KEY]);

      if (onlyIfFirst && (await this.anyAccountExists(manager))) {
        return null;
      }

      const saved = await manager.save(instance);

      // Before the event, so nothing observing UserCreated can read a half-claimed appliance.
      saved.role = (await this.claimApplianceIfUnowned(manager, saved.id)) ? 'admin' : saved.role;

      await alongside?.(manager, UserEntity.toEgressType(saved));

      return saved;
    });

    if (entity == null) {
      return null;
    }

    // After the commit, so every listener finds the account — and whatever `alongside` wrote.
    await this.eventService.send(UserCreatedEvent, {
      userId: entity.id,
    });

    return UserEntity.toEgressType(entity);
  }

  /**
   * Whether this appliance has ever had an account: any row in `ci.users`, soft-deleted or not.
   * The single definition behind both {@link hasNoUsers} and {@link createFirstAccount}, so the
   * unlocked answer and the locked decision cannot drift apart.
   */
  private async anyAccountExists(manager: EntityManager): Promise<boolean> {
    const [row] = await manager.query<Array<{ present: boolean }>>(
      `SELECT EXISTS (SELECT 1 FROM ci.users) AS present`,
    );

    return row?.present === true;
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
   * control plane stays open to everyone forever. It is also narrower than it sounds: the doors
   * that need no invitation still count that deleted account (see {@link createFirstAccount}), so
   * "the next account" is one somebody let in.
   *
   * Runs in {@link insertAccount}'s transaction, under its advisory lock, because the decision reads
   * a table it is about to write. Two signups racing on a fresh appliance would otherwise both
   * observe "no admin" under READ COMMITTED and both promote — a small consequence (two admins on a
   * single-owner box, both among its first two accounts) but a silent one.
   *
   * @returns whether this account was promoted.
   */
  private async claimApplianceIfUnowned(manager: EntityManager, userId: string): Promise<boolean> {
    // Wrapped in a CTE so the OUTER command is a SELECT, which is the only shape TypeORM's
    // Postgres driver resolves to the rows themselves. A bare `UPDATE ... RETURNING` resolves to
    // the pair `[rows, rowCount]` instead, and this used to read that pair's length — 2, whatever
    // the UPDATE matched — as "promoted": `create()` handed back `role: 'admin'` for EVERY new
    // account while the row correctly stayed 'user'. `PortalTokenService.provisionUser` puts that
    // object straight onto `request.user`, which is what both admin guards read. Same trap as
    // `PipelineControlService.reapExpiredShardLeases`; see its comment for the driver detail.
    const promoted = await manager.query<Array<{ id: string }>>(
      `WITH promoted AS (
         UPDATE ci.users
            SET role = 'admin'
          WHERE id = $1
            AND NOT EXISTS (
              SELECT 1 FROM ci.users WHERE role = 'admin' AND deleted_at IS NULL
            )
        RETURNING id)
       SELECT id FROM promoted`,
      [userId],
    );

    return promoted.length > 0;
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

    // No id names no account. TypeORM drops an `undefined` where-value from the SQL, so passing one
    // through returned the first row of `ci.users` instead of nothing.
    if (typeof id !== 'string' || id.length === 0) {
      return null;
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

    // From here the user knows a password, so `requireReauth` may ask for it —
    // including on an OIDC-linked account that just set its first one.
    await this.userRepository.update(id, { password: hashedPassword, passwordSetAt: new Date() });

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
   *
   * ⚠️ An answer for this instant, good for telling someone what to expect
   * (whether the signup form needs a code field) and for refusing early. Never
   * create an account on the strength of it: another request can claim the
   * appliance between this answer and the INSERT. That decision belongs to
   * {@link createFirstAccount}, which asks again under the lock every account
   * creation takes.
   */
  async hasNoUsers(): Promise<boolean> {
    return !(await this.anyAccountExists(this.userRepository.manager));
  }

  async findByEmail(email: string): Promise<User | null> {
    const result = await this.userRepository.findOne({
      where: {
        email,
      },
    });

    return result ? UserEntity.toEgressType(result) : null;
  }

  /**
   * Every live account whose address equals `email` once both are case-folded.
   *
   * `email` is `TEXT UNIQUE` and {@link findByEmail} compares it exactly, while the Hub lower-cases
   * every username it signs (CI-Hub migration 0062 folded the old ones in place). An account signed
   * up as `Owner@Example.com` is the same person the Hub calls `owner@example.com`, and an exact
   * lookup misses them. Soft-deleted rows are left out, as everywhere else on this repository.
   */
  async findByEmailIgnoringCase(email: string): Promise<User[]> {
    const results = await this.userRepository
      .createQueryBuilder('user')
      .where('LOWER(user.email) = LOWER(:email)', { email: email.trim() })
      .orderBy('user.createdAt', 'ASC')
      .getMany();

    return results.map((result) => UserEntity.toEgressType(result));
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
