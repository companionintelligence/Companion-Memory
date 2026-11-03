import { randomBytes } from 'crypto';

import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import bcrypt from 'bcrypt';
import { EntityManager, IsNull, QueryDeepPartialEntity, Raw, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { ServiceContext, SYSTEM_USER } from '@ci/common/context';
import config from '@ci/configuration';
import { EventService } from '@ci/domains/events';

import { normalizeEmail } from '../email';
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

/** What a deletion request may carry besides the account it ends. */
export interface DeletionOptions {
  /**
   * The address of a live account to make administrator in the same transaction. Required when
   * the account being deleted is the appliance's last live administrator and other live accounts
   * remain; ignored otherwise.
   */
  successorEmail?: string;
}

/**
 * Why {@link UserService.requestDeletion} refused to delete the appliance's last live
 * administrator. Nothing was written.
 *
 * - `successor_required`: other live accounts remain, and the request named nobody to take over.
 * - `successor_not_found`: the named address is not another live account on this appliance.
 */
export class LastAdminDeletionRefused extends Error {
  constructor(readonly reason: 'successor_required' | 'successor_not_found') {
    super(
      reason === 'successor_required'
        ? 'The last administrator cannot be deleted while other accounts remain'
        : 'The named successor is not another live account on this appliance',
    );
    this.name = 'LastAdminDeletionRefused';
  }

  /** The 409 every account-deletion route answers with. The web app reads its `message`. */
  toConflict(): ConflictException {
    return new ConflictException(
      this.reason === 'successor_required'
        ? {
            message: SUCCESSOR_REQUIRED,
            detail:
              'You are the only administrator and other people have accounts here. Name the person who takes over.',
          }
        : {
            message: SUCCESSOR_NOT_FOUND,
            detail: 'No other account on this Memory uses that address.',
          },
    );
  }
}

/**
 * The `message` of a 409 from an account deletion when the caller is the last administrator and
 * other people still have accounts: name a successor (`successorEmail`) and ask again.
 */
export const SUCCESSOR_REQUIRED = 'SUCCESSOR_REQUIRED';

/** The `message` of a 409 from an account deletion whose `successorEmail` names no other live account. */
export const SUCCESSOR_NOT_FOUND = 'SUCCESSOR_NOT_FOUND';

/** A lookup by address that matched more than one account once case is ignored. */
type Ambiguous = 'ambiguous';

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
   * empty as a fresh install, and is claimable again. The admin claim asks the same question, so
   * an owner who deleted their account is never replaced as admin by whoever is created next.
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
    const { passwordChosenByUser = true, emailProven = false, ...columns } = data;
    // Before the transaction opens: bcrypt is the slow part, and nobody queued on the lock should
    // wait for it as well.
    const hashedPassword = await bcrypt.hash(data.password, config.auth.local.saltRounds);

    const instance = this.userRepository.create({
      ...columns,
      id,
      // One spelling per address, whichever door the account came through.
      email: normalizeEmail(columns.email),
      password: hashedPassword,
      passwordSetAt: passwordChosenByUser ? new Date() : null,
      emailProvenAt: emailProven ? new Date() : null,
    });

    const entity = await this.userRepository.manager.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1)', [APPLIANCE_CLAIM_LOCK_KEY]);

      if (onlyIfFirst && (await this.anyAccountExists(manager))) {
        return null;
      }

      const saved = await manager.save(instance);

      // Before the event, so nothing observing UserCreated can read a half-claimed appliance. The
      // returned account says what the row now says: admin, with its address proven.
      if (await this.claimApplianceIfUnowned(manager, saved.id)) {
        saved.role = 'admin';
        saved.emailProvenAt ??= new Date();
      }

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
   * ── The first account EVER, not "whoever comes after the owner" ───────────
   *
   * This used to promote any account created while no LIVE admin existed. That is also the state
   * an owner leaves behind by deleting their account while members keep theirs, and in that state
   * {@link ApplianceAdminGuard} admitted every member, including to `POST /signup-codes`. A member
   * could mint an invitation, sign up a second account and have it promoted here.
   *
   * So the test is now the one {@link createFirstAccount} asks: no OTHER row in `ci.users`, live
   * or soft-deleted. An account awaiting its purge still means this box was claimed. Once the
   * purge removes the last row the appliance is as empty as a fresh install, and its next account
   * claims it again.
   *
   * An appliance whose admin is gone while other accounts remain therefore has no admin until
   * someone names one. `requestDeletion` refuses to produce that state while other live accounts
   * exist (the last admin must name a successor). It still arises on a box upgraded while already
   * in it, after an operator edits `ci.users` by hand, and when the only account is deleted and
   * somebody else's account is created before the purge removes it: that account is not the first
   * row, so it is not promoted, and nothing promotes it after the purge either. The way out is an
   * operator's: clear the departed owner's `deleted_at` and `purge_after` inside the grace period,
   * or set `role = 'admin'` on the account that should hold it (`make dbshell`).
   *
   * The first account's address is also marked proven (`email_proven_at`). Nobody else is on the
   * appliance yet, so it cannot be another person's address planted to receive their Portal or
   * Hub sign-in, which is the case the proof exists for. The owner who signed up with a password
   * keeps their Portal sign-in.
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
            SET role = 'admin',
                email_proven_at = COALESCE(email_proven_at, now())
          WHERE id = $1
            AND NOT EXISTS (
              SELECT 1 FROM ci.users WHERE id <> $1
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
    // Ordered, oldest first. `BlueBubblesSyncService` used to attribute the
    // appliance-wide connector's corpus to the FIRST row here, and without an
    // ORDER BY consecutive syncs on a two-account appliance could file the same
    // messages under different users. It now reads the connector's recorded
    // owner instead, which migration 20261006065617 backfilled with this same
    // first row. Oldest-first is also the only stable meaning "first account"
    // can have.
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

    // An address arriving here is held to the same rules as `changeEmail`: one spelling, and no
    // longer proven.
    const patch =
      data.email === undefined ? data : { ...data, email: normalizeEmail(data.email), emailProvenAt: null };

    await this.userRepository.update(id, patch as QueryDeepPartialEntity<UserEntity>);

    await this.eventService.send(UserUpdatedEvent, {
      userId: id,
    });

    return this.findById(context, id);
  }

  /**
   * Point the account at its self Person, but only while the pointer still
   * holds `expected` (the value the caller read, `null` for none). Two writers
   * can each decide the account has no self Person yet (onboarding and an import
   * that provisions one); a plain {@link update} lets the later one overwrite the
   * earlier and leaves two `is_self` Persons. Returns the pointer the account
   * ends up with: `entityId` when this call set it, otherwise whatever the
   * account holds now, for the caller to adopt.
   *
   * `null` is a possible return and does NOT mean this call set anything: the
   * pointer was cleared after the caller read it, or the account row is gone.
   * A caller that needs the pointer set tries again with the value returned as
   * its new `expected`.
   */
  async setEntityIdIfUnchanged(
    context: ServiceContext,
    id: string,
    entityId: string,
    expected: string | null,
  ): Promise<string | null> {
    if (context.userId !== SYSTEM_USER && context.userId !== id) {
      throw new UnauthorizedException();
    }

    const result = await this.userRepository.update(
      { id, entityId: expected == null ? IsNull() : expected },
      { entityId },
    );

    if ((result.affected ?? 0) > 0) {
      await this.eventService.send(UserUpdatedEvent, {
        userId: id,
      });

      return entityId;
    }

    return (await this.findById(context, id))?.entityId ?? null;
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
   * ── The last administrator ─────────────────────────────────────────────────
   *
   * Refused, with {@link LastAdminDeletionRefused}, when this is the appliance's last live
   * administrator and other live accounts remain, unless `options.successorEmail` names one of
   * them. That account is promoted in the same transaction. Deleting the owner used to leave the
   * members on a box with no live admin, where {@link ApplianceAdminGuard} admitted all of them
   * and any of them could mint the invitation that made the next admin. The decision takes the
   * lock every account creation takes, so two admins deleting at once cannot each count the other
   * as the one who stays, and no account can be created between the count and the write.
   *
   * ── Invitations ────────────────────────────────────────────────────────────
   *
   * The account's unused invitations are deleted in the same transaction: an invitation is the
   * issuer's decision to let someone in, and an issuer who has left can no longer stand behind it.
   * Raw SQL against `ci.signup_code` because that table belongs to the auth domain, which depends
   * on this one and not the other way round.
   *
   * Idempotent: a second request finds nothing (the first one hid the row) and
   * returns false rather than throwing.
   */
  async requestDeletion(
    context: ServiceContext,
    id: string,
    options: DeletionOptions = {},
  ): Promise<boolean> {
    if (context.userId !== SYSTEM_USER && context.userId !== id) {
      throw new UnauthorizedException();
    }

    const purgeAfter = new Date(Date.now() + purgeGraceDays() * 24 * 60 * 60 * 1000);

    return (await this.endAccount(id, options, purgeAfter)) != null;
  }

  /**
   * The last-administrator rule of {@link requestDeletion}, asked without the lock and without
   * writing anything: throws {@link LastAdminDeletionRefused} when ending account `id` now would be
   * refused. For a caller that does something irreversible before it ends the account (the immediate
   * delete revokes the OAuth grants first, so the provider side stops even if what follows fails)
   * and should not do it for a request that will be refused anyway.
   *
   * Only a forecast: {@link endAccountNow} asks again under the lock, and that answer is the one that
   * counts. An account that disappears in between makes this answer nothing.
   */
  async assertMayEndAccount(
    context: ServiceContext,
    id: string,
    options: DeletionOptions = {},
  ): Promise<void> {
    if (context.userId !== SYSTEM_USER && context.userId !== id) {
      throw new UnauthorizedException();
    }

    const manager = this.userRepository.manager;
    const [target] = await manager.query<Array<{ role: string }>>(
      `SELECT role FROM ci.users WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );

    if (target?.role === 'admin') {
      await this.successorFor(manager, id, options);
    }
  }

  /**
   * End account `id` now and leave its data to the purge, due at once: the first half of the privacy
   * route's immediate delete (`POST /users/me/delete`). Everything {@link requestDeletion} does, in
   * the same short transaction under the same lock (the last-administrator rule, the successor's
   * promotion, the account hidden from every read, its unused invitations deleted), with
   * `purge_after` set to now instead of after the grace period.
   *
   * The caller runs the purge right after (`AccountPurgeService.purgeAccount`): batched, resumable,
   * and outside this lock. If the process dies before it finishes, the hourly purge finds the account
   * due and finishes it. This used to delete every row inside this transaction instead, which held the
   * lock every sign-up waits on for as long as the delete took (49 minutes and counting for a large
   * graph, in review) and lost all of it to any interruption.
   *
   * @param alongside the caller's writes that must commit with the account's end and only with it
   *   (the audit row, the sessions and keys revoked), run last in the transaction. If it throws, the
   *   account is not ended.
   * @returns null when there is no live account `id` (already ended), and nothing was written.
   */
  async endAccountNow<T>(
    context: ServiceContext,
    id: string,
    options: DeletionOptions,
    alongside: (manager: EntityManager) => Promise<T>,
  ): Promise<{ requestedAt: Date; purgeAfter: Date; result: T } | null> {
    if (context.userId !== SYSTEM_USER && context.userId !== id) {
      throw new UnauthorizedException();
    }

    const now = new Date();
    const ended = await this.endAccount(id, options, now, alongside);

    return ended && { requestedAt: now, purgeAfter: now, result: ended.result as T };
  }

  /**
   * End account `id`: the shared half of {@link requestDeletion} and {@link endAccountNow}. Events go
   * out after the commit.
   */
  private async endAccount(
    id: string,
    options: DeletionOptions,
    purgeAfter: Date,
    alongside?: (manager: EntityManager) => Promise<unknown>,
  ): Promise<{ result: unknown } | null> {
    const outcome = await this.userRepository.manager.transaction(async (manager) => {
      const handedOver = await this.lockAndHandOver(manager, id, options);

      if (!handedOver) {
        return null;
      }

      // One write, not `softDelete()` then `update()`: the access gate (`deletedAt`) and
      // the promise about when the data goes (`purgeAfter`) must never exist apart.
      await manager.update(UserEntity, id, { deletedAt: new Date(), purgeAfter });

      await manager.query(`DELETE FROM ci.signup_code WHERE issued_by = $1 AND used = false`, [id]);

      await this.closeSharedAccess(manager, id);

      return { successorId: handedOver.successorId, result: await alongside?.(manager) };
    });

    if (outcome == null) {
      return null;
    }

    if (outcome.successorId) {
      await this.eventService.send(UserUpdatedEvent, { userId: outcome.successorId });
    }

    await this.eventService.send(UserRemovedEvent, {
      userId: id,
    });

    return { result: outcome.result };
  }

  /**
   * Close every way another person reads account `id`'s memory without signing in as it, in the
   * transaction that ends the account. Hiding the user row stops the account's own sign-ins, but
   * these paths never resolve the owner through it: a shared saved search runs as its owner from the
   * token alone (`SavedSearchService.findByShareToken`), and an inbound peer ask is answered as the
   * owner of whichever live `ci.peer_links` row matches the peer (`PeerAskService.resolveLink`).
   * Left alone they kept answering until the purge reached those tables, which is hours into an
   * immediate delete of a large account and the whole 30-day grace period of `DELETE /account`.
   *
   * Each write is the one the owner's own control makes: unsharing (`setSharing(false)`), revoking a
   * peer link, revoking a grant. They are not undone by an operator restoring the account inside
   * the grace period; its owner shares and links again, which also rotates the share tokens.
   * Raw SQL for the reason the invitations above are: those tables belong to domains that depend on
   * this one.
   */
  private async closeSharedAccess(manager: EntityManager, id: string): Promise<void> {
    await manager.query(
      `UPDATE ci.saved_searches
          SET is_public = false, share_token = NULL, share_max_disclosure = NULL, share_expires_at = NULL
        WHERE user_id = $1 AND (is_public OR share_token IS NOT NULL)`,
      [id],
    );
    await manager.query(
      `UPDATE ci.peer_links
          SET status = 'revoked', revoked_at = now(), updated_at = now()
        WHERE owner_user_id = $1 AND revoked_at IS NULL`,
      [id],
    );
    await manager.query(
      `UPDATE ci.ask_grants
          SET revoked_at = now(), revocation_reason = 'revoked', updated_at = now()
        WHERE owner_user_id = $1 AND revoked_at IS NULL`,
      [id],
    );
  }

  /**
   * Under the lock every account creation takes: find live account `id` (null when there is none)
   * and, when it is the last live administrator, promote the successor {@link successorFor} names.
   * Throws {@link LastAdminDeletionRefused} before writing anything.
   */
  private async lockAndHandOver(
    manager: EntityManager,
    id: string,
    options: DeletionOptions,
  ): Promise<{ successorId: string | null } | null> {
    await manager.query('SELECT pg_advisory_xact_lock($1)', [APPLIANCE_CLAIM_LOCK_KEY]);

    // FOR UPDATE: a row written for this account from here on (a foreign key takes KEY SHARE on
    // this row) waits for this transaction to commit. It then succeeds: the foreign key checks
    // only that the row exists, not `deleted_at`. Such a row is left to the purge, which runs a
    // second pass when one blocks the account row's delete (`DataDeletionService.purgeEndedAccount`)
    // and otherwise is retried by the hourly purge.
    const [target] = await manager.query<Array<{ id: string; role: string }>>(
      `SELECT id, role FROM ci.users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [id],
    );

    if (!target) {
      return null;
    }

    const successorId = target.role === 'admin' ? await this.successorFor(manager, id, options) : null;

    if (successorId) {
      await manager.query(`UPDATE ci.users SET role = 'admin' WHERE id = $1`, [successorId]);
    }

    return { successorId };
  }

  /**
   * The account that becomes administrator when admin `id` leaves, or null when none has to.
   *
   * None has to when another live admin stays, or when nobody else is left at all (the appliance
   * then empties out and its next first account claims it). Otherwise the request must name a live
   * account other than `id`, by the address it signs in with.
   */
  private async successorFor(
    manager: EntityManager,
    id: string,
    options: DeletionOptions,
  ): Promise<string | null> {
    const [others] = await manager.query<Array<{ admins: boolean; accounts: boolean }>>(
      `SELECT EXISTS (
                SELECT 1 FROM ci.users WHERE role = 'admin' AND deleted_at IS NULL AND id <> $1
              ) AS admins,
              EXISTS (
                SELECT 1 FROM ci.users WHERE deleted_at IS NULL AND id <> $1
              ) AS accounts`,
      [id],
    );

    if (others?.admins === true || others?.accounts === false) {
      return null;
    }

    if (!options.successorEmail?.trim()) {
      throw new LastAdminDeletionRefused('successor_required');
    }

    const candidates = await manager.query<Array<{ id: string }>>(
      `SELECT id FROM ci.users
        WHERE deleted_at IS NULL
          AND id <> $1
          AND lower(email) = $2`,
      [id, normalizeEmail(options.successorEmail)],
    );

    if (candidates.length !== 1) {
      throw new LastAdminDeletionRefused('successor_not_found');
    }

    return candidates[0].id;
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

  /**
   * The account a password login names, and whether the password is its own.
   *
   * `accountExists` is reported separately so the login throttle can keep a per-account budget for
   * names that are accounts without one for every made-up name. An address that matches no account
   * still pays for a bcrypt comparison, against a hash of the same cost, so the response time does
   * not say whether the account exists and a flood of made-up names costs what real guesses do.
   */
  async authenticatePassword(
    email: string,
    password: string,
  ): Promise<{ user: User | null; accountExists: boolean }> {
    const found = await this.findEntityByEmail(email);

    if (found == null || found === 'ambiguous') {
      await bcrypt.compare(password, await this.dummyPasswordHash());

      return { user: null, accountExists: found === 'ambiguous' };
    }

    const validCredentials = await bcrypt.compare(password, found.password);

    return { user: validCredentials ? UserEntity.toEgressType(found) : null, accountExists: true };
  }

  async validatePassword(email: string, password: string): Promise<User | null> {
    return (await this.authenticatePassword(email, password)).user;
  }

  /** A hash nobody's password matches, at the configured cost; computed once per process. */
  private dummyHash: Promise<string> | null = null;

  private dummyPasswordHash(): Promise<string> {
    this.dummyHash ??= bcrypt.hash(randomBytes(32).toString('hex'), config.auth.local.saltRounds);

    return this.dummyHash;
  }

  /**
   * Change the authenticated user's own email. Callers must have already
   * verified `checkEmailAvailability` and, for non-federated accounts,
   * re-authenticated with the current password — this method just writes.
   * The address is stored normalized and unproven.
   */
  async changeEmail(context: ServiceContext, id: string, newEmail: string): Promise<User | null> {
    if (context.userId !== SYSTEM_USER && context.userId !== id) {
      throw new UnauthorizedException();
    }

    // Nothing showed the new address is this person's, so it stops counting as proven: the
    // Portal email link and the Hub bridge will not link anyone into this account by it.
    await this.userRepository.update(id, { email: normalizeEmail(newEmail), emailProvenAt: null });

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
        // Whatever its case: `users_email_lower_uniq` would refuse the INSERT for any spelling of
        // an address that is already here.
        email: Raw((column) => `LOWER(${column}) = :email`, { email: normalizeEmail(email) }),
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

  /**
   * The live account an address names, or null when none does or more than one might.
   * See {@link findAccountByEmail}, which tells those last two apart.
   */
  async findByEmail(email: string): Promise<User | null> {
    const found = await this.findAccountByEmail(email);

    return found === 'ambiguous' ? null : found;
  }

  /**
   * The live account an address names: the exact address, else the only account whose address
   * matches it once case is ignored. `'ambiguous'` when several do, which since addresses are
   * stored lower-cased happens only for rows that already collided by case before that rule (see
   * migration 20261006065832). Each of those still signs in with its exact address.
   */
  async findAccountByEmail(email: string): Promise<User | Ambiguous | null> {
    const found = await this.findEntityByEmail(email);

    return found == null || found === 'ambiguous' ? found : UserEntity.toEgressType(found);
  }

  private async findEntityByEmail(email: string): Promise<UserEntity | Ambiguous | null> {
    const exact = await this.userRepository.findOne({
      where: {
        email: email.trim(),
      },
    });

    if (exact) {
      return exact;
    }

    const folded = await this.userRepository.find({
      where: { email: Raw((column) => `LOWER(${column}) = :email`, { email: normalizeEmail(email) }) },
      order: { createdAt: 'ASC' },
      take: 2,
    });

    if (folded.length > 1) {
      return 'ambiguous';
    }

    return folded[0] ?? null;
  }

  /**
   * Whether `user`'s address is proven to be theirs: the bar the Portal email link and the Hub
   * bridge's adoption by username hold an account to before trusting its address.
   */
  isEmailProven(user: Pick<User, 'emailProvenAt'>): boolean {
    return user.emailProvenAt != null;
  }

  /**
   * Record that `id`'s current address is proven to be its holder's: the Hub vouched for it as
   * the person's username while they were signed in to this very account.
   */
  async markEmailProven(id: string): Promise<void> {
    await this.userRepository.update(id, { emailProvenAt: new Date() });
  }

  /**
   * Every live account whose address equals `email` once both are case-folded.
   *
   * Addresses are stored lower-cased now, and the Hub lower-cases every username it signs (CI-Hub
   * migration 0062 folded the old ones in place). Rows that collided by case before addresses were
   * normalized keep their original spelling, so this can still return more than one. Soft-deleted
   * rows are left out, as everywhere else on this repository.
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
