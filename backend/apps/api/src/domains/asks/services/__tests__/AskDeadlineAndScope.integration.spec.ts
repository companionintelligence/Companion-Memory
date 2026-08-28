import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { LoggerService } from '@ci/common/logging';
import { UserEntity } from '@ci/domains/user';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { DEFAULT_ASK_TTL_HOURS } from '../../askDeadline';
import { AskAnswerEntity } from '../../entities/AskAnswerEntity';
import { AskAuditEntity } from '../../entities/AskAuditEntity';
import { AskEntity } from '../../entities/AskEntity';
import { AskGrantEntity } from '../../entities/AskGrantEntity';
import { AskAnswerService } from '../AskAnswerService';
import { AskAuditService } from '../AskAuditService';
import { AskExpiryService } from '../AskExpiryService';
import { AskService } from '../AskService';
import { GrantService } from '../GrantService';

/**
 * ═══ `expires_at` HAD THREE READERS AND NO WRITER ═══
 *
 * `ci.asks.expires_at` is read by `AskExpiryService.sweep`, by
 * `AskType.expiresAt`, and by the `answering → expired` edge added to the state
 * machine for it. Nothing ever wrote one: `AskService.create` took
 * `data.expiresAt` with a `?? null` fallback and no caller passed the field —
 * verified against a live harness, where 0 of 53 asks carried a deadline. A
 * NULL never satisfies a SQL comparison, so the sweep scanned, matched nothing,
 * and logged nothing, forever.
 *
 * `AskExpiryService`'s own docstring names the consequence and it is not
 * cosmetic: an ask sitting in `answering` is answerable by definition, and
 * `AskService.complete` deliberately does not re-check the standing grant on
 * the owner-approved path. An approved ask with no deadline is therefore "a
 * permanent, revocation-immune authorization to disclose in full".
 *
 * This is proved AGAINST REAL POSTGRES on purpose. The defect was in what a
 * query RETURNS — a `LessThan(now)` predicate against a NULL column — and a
 * mocked repository handed the sweep a list of rows it had chosen itself, so it
 * modelled the fix and could never have shown the bug.
 *
 * The two ownership scopes asserted at the bottom are here for the same reason:
 * `responderOwned` and `listForResponder` are single WHERE clauses, and only
 * real rows belonging to a real other person can show that they exclude them.
 *
 * Opt-in: set `ASKS_TEST_DATABASE_URL` (or `DATABASE_URL` / `DATABASE_PASSWORD`,
 * as `yarn test` already does from the repo-root `.env`) to a database with
 * migrations applied.
 */
const availability = databaseAvailability({ urlEnvVar: 'ASKS_TEST_DATABASE_URL' });
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[asks/AskDeadlineAndScope.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`ask deadlines and ownership — against real Postgres (${availability.target})`, () => {
  const owner = { userId: uuidv7() };
  const asker = { userId: uuidv7() };
  const stranger = { userId: uuidv7() };

  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as LoggerService;

  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let askService: AskService;
  let auditService: AskAuditService;
  let expiryService: AskExpiryService;

  const askIds: string[] = [];

  /** Submit an ask from `asker` to `owner`, exactly as `createAsk` would. */
  async function createAsk(prompt: string) {
    const ask = await askService.create(asker, {
      responderUserId: owner.userId,
      query: { queryType: 'content', dataClass: 'photos', prompt },
    });
    askIds.push(ask.id);

    return ask;
  }

  async function rawAsk(id: string) {
    const [row] = await dataSource.query('SELECT status, expires_at FROM ci.asks WHERE id = $1', [id]);

    return row as { status: string; expires_at: Date | null };
  }

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: 'ASKS_TEST_DATABASE_URL' });

    if (connection == null) {
      throw new Error('databaseAvailability passed but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
      entities: [AskEntity, AskGrantEntity, AskAuditEntity, AskAnswerEntity, UserEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();

    // SHARED: this suite commits real ci.users / ci.asks rows. See
    // domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'ask deadlines and ownership');

    for (const [{ userId }, name] of [
      [owner, 'DeadlineOwner'],
      [asker, 'DeadlineAsker'],
      [stranger, 'DeadlineStranger'],
    ] as const) {
      await dataSource.query(
        `INSERT INTO ci.users (id, name, email, password, onboarded)
         VALUES ($1, $2, $3, 'x', true)
         ON CONFLICT (id) DO NOTHING`,
        [userId, name, `askdeadline.${name.toLowerCase()}.${userId}@example.test`],
      );
    }

    const grantService = new GrantService(
      dataSource.getRepository(AskGrantEntity),
      dataSource.getRepository(AskEntity),
      noopLogger,
    );
    auditService = new AskAuditService(dataSource.getRepository(AskAuditEntity), noopLogger);
    const answerService = new AskAnswerService(dataSource.getRepository(AskAnswerEntity), noopLogger);

    askService = new AskService(
      dataSource.getRepository(AskEntity),
      dataSource.getRepository(UserEntity),
      grantService,
      auditService,
      answerService,
      dataSource,
      noopLogger,
    );

    expiryService = new AskExpiryService(
      dataSource.getRepository(AskEntity),
      auditService,
      dataSource,
      noopLogger,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      // ON DELETE CASCADE takes the asks, audits and answers with the users.
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1)', [
        [owner.userId, asker.userId, stranger.userId],
      ]);
      // Before `destroy()`: the lock is held on a runner from this pool.
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  describe('every ask is created WITH a deadline', () => {
    it('writes a non-null expires_at roughly one TTL from now', async () => {
      const before = Date.now();
      const ask = await createAsk('do you have photos of the lake trip?');
      const stored = await rawAsk(ask.id);

      // The whole defect in one assertion: this column was NULL on every row.
      expect(stored.expires_at).not.toBeNull();

      const deadline = new Date(stored.expires_at as Date).getTime();
      const ttlMs = DEFAULT_ASK_TTL_HOURS * 60 * 60 * 1000;
      expect(deadline).toBeGreaterThanOrEqual(before + ttlMs - 60_000);
      expect(deadline).toBeLessThanOrEqual(Date.now() + ttlMs + 60_000);
    });

    it('honours an explicit deadline a caller does supply', async () => {
      const explicit = new Date(Date.now() + 90 * 60 * 1000);
      const ask = await askService.create(asker, {
        responderUserId: owner.userId,
        query: { queryType: 'relationship', prompt: 'do you know Alice?' },
        expiresAt: explicit,
      });
      askIds.push(ask.id);

      expect(new Date((await rawAsk(ask.id)).expires_at as Date).getTime()).toBe(explicit.getTime());
    });

    it('reads an explicit NULL as "give me the default", not as "no deadline"', async () => {
      // The two are indistinguishable at this boundary — an omitted field and an
      // explicit null arrive identically from GraphQL — and only one of them is
      // safe. A path that could opt out is the path that reintroduces the
      // revocation-immune authorization this deadline exists to end.
      const ask = await askService.create(asker, {
        responderUserId: owner.userId,
        query: { queryType: 'relationship', prompt: 'do you know Bob?' },
        expiresAt: null,
      });
      askIds.push(ask.id);

      expect((await rawAsk(ask.id)).expires_at).not.toBeNull();
    });
  });

  describe('the expiry sweep can now actually reach a row', () => {
    it('retires an ask whose default deadline has passed, and audits it', async () => {
      const ask = await createAsk('anything from the trip?');
      // The owner approves it, which is the dangerous resting state: `answering`
      // is answerable by definition and is deliberately exempt from retroactive
      // grant withdrawal.
      await askService.approve(owner, ask.id);
      expect((await rawAsk(ask.id)).status).toBe('answering');

      // One second past the default TTL. Before the deadline existed this swept
      // NOTHING at any `now` whatsoever, because the predicate was comparing
      // against NULL.
      const afterDeadline = new Date(Date.now() + (DEFAULT_ASK_TTL_HOURS * 60 + 1) * 60 * 1000);
      const retired = await expiryService.sweep(afterDeadline);

      expect(retired).toBeGreaterThanOrEqual(1);
      expect((await rawAsk(ask.id)).status).toBe('expired');

      const [audited] = await dataSource.query(
        `SELECT outcome FROM ci.ask_audit WHERE ask_id = $1 AND outcome = 'expired'`,
        [ask.id],
      );
      expect(audited).toBeDefined();
    });

    it('leaves an ask alone until its deadline has actually passed', async () => {
      const ask = await createAsk('and the day after?');

      // A minute before the deadline: still live, still the owner's to answer.
      const beforeDeadline = new Date(Date.now() + (DEFAULT_ASK_TTL_HOURS * 60 - 1) * 60 * 1000);
      await expiryService.sweep(beforeDeadline);

      expect((await rawAsk(ask.id)).status).toBe('delivered');
    });
  });

  /**
   * `AskService.responderOwned` is one `findOne({ where: { id, responderUserId
   * } })`, and dropping `responderUserId` from it turns "approve MY ask" into
   * "approve ANY ask" — including consenting on someone else's behalf to a
   * disclosure out of their memory. Nothing pinned it.
   *
   * MUTATION-TESTED: remove the `responderUserId` clause and these go red.
   */
  describe('only the responder may decide their own asks', () => {
    it('refuses approve from the ASKER and from an unrelated user', async () => {
      const ask = await createAsk('approve scoping');

      await expect(askService.approve(asker, ask.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(askService.approve(stranger, ask.id)).rejects.toBeInstanceOf(NotFoundException);

      // …and the ask is untouched, so a refused attempt is not a state change.
      expect((await rawAsk(ask.id)).status).toBe('delivered');

      // The responder still can.
      await askService.approve(owner, ask.id);
      expect((await rawAsk(ask.id)).status).toBe('answering');
    });

    it('refuses decline from the ASKER and from an unrelated user', async () => {
      const ask = await createAsk('decline scoping');

      await expect(askService.decline(asker, ask.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(askService.decline(stranger, ask.id)).rejects.toBeInstanceOf(NotFoundException);
      expect((await rawAsk(ask.id)).status).toBe('delivered');

      // A refused decline must also leave NO audit row: the disclosure history
      // is the owner's record, and a stranger must not be able to write to it.
      const rows = await dataSource.query('SELECT id FROM ci.ask_audit WHERE ask_id = $1', [ask.id]);
      expect(rows).toHaveLength(0);

      await askService.decline(owner, ask.id);
      expect((await rawAsk(ask.id)).status).toBe('declined');
    });
  });

  /**
   * The disclosure history is scoped by `listForResponder`'s
   * `where: { responderUserId }`. Drop it and every owner's history becomes
   * every other owner's — including the peer handles, the query prompts and the
   * disclosed-entity ids of asks they were never party to.
   *
   * MUTATION-TESTED: remove the WHERE clause and this goes red.
   */
  describe('the disclosure history belongs to its responder', () => {
    it('shows the owner their own rows and nobody else’s', async () => {
      const ask = await createAsk('history scoping');
      await askService.decline(owner, ask.id);

      const ownerHistory = await auditService.listForResponder(owner);
      expect(ownerHistory.rows.some((row) => row.askId === ask.id)).toBe(true);

      // The ASKER is a participant in this very ask and still sees nothing:
      // the history is the RESPONDER's record of what left their box.
      expect((await auditService.listForResponder(asker)).rows).toEqual([]);
      expect((await auditService.listForResponder(stranger)).rows).toEqual([]);
    });

    /**
     * The narrowing filters must not be a way OUT of the responder scope. Every
     * one of them is an additional WHERE on the same query, so a filter can only
     * ever shrink the owner's own set — but that is the kind of property worth
     * pinning rather than reasoning about, because the filters arrive from a
     * client.
     */
    it('cannot be widened past the responder by any filter', async () => {
      const ask = await createAsk('filter scoping');
      await askService.decline(owner, ask.id);

      // The asker filters for their OWN id against the stranger's history and
      // still gets nothing: the responder clause is applied first and always.
      const escaped = await auditService.listForResponder(stranger, {
        askerUserId: asker.userId,
        outcomes: ['declined'],
      });
      expect(escaped.rows).toEqual([]);

      // And the same filter, run by the actual responder, does find it.
      const found = await auditService.listForResponder(owner, { outcomes: ['declined'] });
      expect(found.rows.some((row) => row.askId === ask.id)).toBe(true);
    });

    it('folds the owner’s rows by relationship, and nobody else’s', async () => {
      const ask = await createAsk('summary scoping');
      await askService.decline(owner, ask.id);

      const { summaries } = await auditService.summaryForResponder(owner);
      const mine = summaries.find((s) => s.counterparty.askerUserId === asker.userId);
      expect(mine?.declined).toBeGreaterThanOrEqual(1);

      expect((await auditService.summaryForResponder(stranger)).summaries).toEqual([]);
    });
  });
});
