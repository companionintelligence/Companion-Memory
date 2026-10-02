import { randomUUID } from 'node:crypto';

import { DataSource, type QueryRunner } from 'typeorm';

import { type ServiceContext } from '@ci/common/context';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { migrationSection } from '../../__tests__/expandedReflectionsMigration';
import { QuestionEntity } from '../../entities/QuestionEntity';
import { QuestionService } from '../QuestionService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A FORK KEEPS ITS ORIGIN'S `evidence_class`, READ BACK FROM A REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Editing a shared catalogue question mints a private copy of it
 * (`QuestionService.forkSharedQuestion`), and that copy hides its origin from
 * both inference selectors. The copy was built field by field and
 * `evidence_class` was not one of them, so the INSERT left it out and a reworded
 * 'hand_entry' question came back as the column default, 'traceable' — the only
 * copy the selectors could still see, and the one question the job must never
 * answer on someone's behalf (20260825185434).
 *
 * That is a statement about what the database ends up holding, so it is read
 * with SQL rather than through the entity, and a mocked repository could not say
 * it: it hands back whatever the code gave it.
 *
 * What this suite pins:
 *
 *   1. A fork has the class its origin has — 'hand_entry' for one, 'traceable'
 *      for the other, which is what shows it is READ off the origin rather than
 *      hard-coded either way.
 *   2. The reuse path. A second edit finds the existing copy, and leaves it the
 *      class it has: both when that is the origin's, and when it is STRICTER than
 *      the origin's, which copying the origin's again would have loosened.
 *   3. The repair, 20261001153728, applied from the file as it sits on disk:
 *      forks of 'hand_entry' questions that are still 'traceable' become
 *      'hand_entry', their machine-written answers go, and nothing else moves.
 *
 * Everything runs in one transaction that is always rolled back. Nothing is
 * committed, so the shared catalogue is untouched and there is nothing to clean up.
 */

const availability = databaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[intelligence/QuestionService.forkEvidenceClass] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const REPAIR_MIGRATION = '20261001153728_repair_forks_of_hand_entry_questions.sql';

type EvidenceClass = 'traceable' | 'hand_entry';
type AnswerSource = 'user_input' | 'inferred' | 'observed' | 'imported';

describeWithDatabase(`QuestionService forks and evidence_class (${availability.target})`, () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  let service: QuestionService;
  let ownerId: string;
  let otherId: string;
  let thirdId: string;

  const asUser = (userId: string) => ({ userId }) as ServiceContext;

  async function insertQuestion(question: {
    id: string;
    label: string;
    evidenceClass?: EvidenceClass;
    privateTo?: string;
    forkedFrom?: string;
  }) {
    await runner.query(
      `INSERT INTO ci.questions
         (question_id, question_text, question_category, question_type, answer_tier, evidence_class,
          is_private_to, forked_from_question_id)
       VALUES ($1, $2, 'Fork evidence class', 'open_ended', 'factual', $3, $4, $5)`,
      [
        question.id,
        `Fork evidence class fixture: ${question.label} ${question.id}`,
        question.evidenceClass ?? 'traceable',
        question.privateTo ?? null,
        question.forkedFrom ?? null,
      ],
    );
  }

  async function insertAnswer(questionId: string, userId: string, source: AnswerSource) {
    await runner.query(
      `INSERT INTO ci.answers (question_id, user_id, answer_text, answer_source)
       VALUES ($1, $2, $3, $4)`,
      [questionId, userId, `a ${source} answer`, source],
    );
  }

  async function classOf(questionId: string): Promise<string | undefined> {
    const rows = (await runner.query('SELECT evidence_class FROM ci.questions WHERE question_id = $1', [
      questionId,
    ])) as Array<{ evidence_class: string }>;

    return rows[0]?.evidence_class;
  }

  /** The copy `userId` holds of `originId`, as the database has it. */
  async function forkRow(originId: string, userId: string) {
    const rows = (await runner.query(
      `SELECT question_id, evidence_class, is_private_to, forked_from_question_id
         FROM ci.questions
        WHERE forked_from_question_id = $1 AND is_private_to = $2`,
      [originId, userId],
    )) as Array<{
      question_id: string;
      evidence_class: string;
      is_private_to: string;
      forked_from_question_id: string;
    }>;

    return rows;
  }

  beforeAll(async () => {
    const connection = resolveConnection();

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
      // The service reaches the table through the entity's repository.
      entities: [QuestionEntity],
    });
    await dataSource.initialize();

    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    // `dataSource.query` is reached for the answer hand-over and the feed queue,
    // and every statement has to run on the transaction's own connection or it
    // would not see the fixtures. The repository is bound to the runner for the
    // same reason; events go nowhere.
    const forwarding = {
      query: (sql: string, params?: unknown[]) => runner.query(sql, params),
    } as unknown as DataSource;

    service = new QuestionService(forwarding, runner.manager.getRepository(QuestionEntity), {
      send: async () => [],
    } as never);

    const query = (sql: string, params?: unknown[]) => runner.query(sql, params);

    ownerId = await createSyntheticTestUser(query, 'ForkEvidenceOwner');
    otherId = await createSyntheticTestUser(query, 'ForkEvidenceOther');
    thirdId = await createSyntheticTestUser(query, 'ForkEvidenceThird');
  });

  afterAll(async () => {
    if (runner?.isTransactionActive) {
      await runner.rollbackTransaction();
    }

    await runner?.release();

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  describe('editing a shared question', () => {
    it.each<EvidenceClass>(['hand_entry', 'traceable'])(
      'gives the private copy of a %s question the class its origin has',
      async (evidenceClass) => {
        const origin = randomUUID();

        await insertQuestion({ id: origin, label: `${evidenceClass} origin`, evidenceClass });

        const fork = await service.update(asUser(ownerId), origin, { text: 'reworded' });

        // Really a fork: a new row, private to the editor, pointing at the origin.
        expect(fork?.id).toEqual(expect.any(String));
        expect(fork?.id).not.toBe(origin);
        expect(await forkRow(origin, ownerId)).toEqual([
          {
            question_id: fork?.id,
            evidence_class: evidenceClass,
            is_private_to: ownerId,
            forked_from_question_id: origin,
          },
        ]);

        // And the shared row is exactly what it was.
        expect(await classOf(origin)).toBe(evidenceClass);
      },
    );

    it('keeps the class when a second edit reuses the copy', async () => {
      const origin = randomUUID();

      await insertQuestion({ id: origin, label: 'hand entry origin', evidenceClass: 'hand_entry' });

      const first = await service.update(asUser(ownerId), origin, { text: 'first' });
      const second = await service.update(asUser(ownerId), origin, { text: 'second' });

      // The same row, edited again rather than a second one minted.
      expect(second?.id).toBe(first?.id);
      expect(second?.text).toBe('second');
      expect(await classOf(first!.id)).toBe('hand_entry');
    });

    it('does not loosen a copy that is stricter than its origin when it is edited again', async () => {
      const origin = randomUUID();
      const strictFork = randomUUID();

      await insertQuestion({ id: origin, label: 'traceable origin' });
      await insertQuestion({
        id: strictFork,
        label: 'a copy classified on its own wording',
        evidenceClass: 'hand_entry',
        privateTo: ownerId,
        forkedFrom: origin,
      });

      const edited = await service.update(asUser(ownerId), origin, { text: 'edited' });

      expect(edited?.id).toBe(strictFork);
      expect(await classOf(strictFork)).toBe('hand_entry');
    });
  });

  describe(`the repair, ${REPAIR_MIGRATION}`, () => {
    /** Fixtures, by what each one is there to show. */
    const q = {
      handOrigin: randomUUID(),
      traceableOrigin: randomUUID(),
      deletedOrigin: randomUUID(),
      /** A fork of a hand_entry question that came out 'traceable': the defect. */
      brokenFork: randomUUID(),
      /** The same defect on somebody else's copy. */
      othersBrokenFork: randomUUID(),
      /** A fork of a hand_entry question that is already right. */
      rightFork: randomUUID(),
      /** A fork of a traceable question: nothing to repair. */
      traceableFork: randomUUID(),
      /** A fork that is stricter than its traceable origin. */
      strictFork: randomUUID(),
      /** A fork whose hand_entry origin has since been deleted. */
      orphan: randomUUID(),
    };

    type Name = keyof typeof q;

    interface State {
      classes: Partial<Record<Name, string>>;
      /** The `answer_source` of every answer on each fixture, in a stable order. */
      answers: Partial<Record<Name, string[]>>;
    }

    const NAMES = (Object.keys(q) as Name[]).filter((name) => name !== 'deletedOrigin');

    async function readState(): Promise<State> {
      const ids = NAMES.map((name) => q[name]);
      const nameOf = new Map<string, Name>(NAMES.map((name) => [q[name], name]));

      const questions = (await runner.query(
        'SELECT question_id, evidence_class FROM ci.questions WHERE question_id = ANY($1::uuid[])',
        [ids],
      )) as Array<{ question_id: string; evidence_class: string }>;
      const answers = (await runner.query(
        'SELECT question_id, answer_source FROM ci.answers WHERE question_id = ANY($1::uuid[])',
        [ids],
      )) as Array<{ question_id: string; answer_source: string }>;

      const state: State = { classes: {}, answers: {} };

      for (const name of NAMES) {
        state.answers[name] = [];
      }

      for (const row of questions) {
        state.classes[nameOf.get(row.question_id)!] = row.evidence_class;
      }

      for (const row of answers) {
        state.answers[nameOf.get(row.question_id)!]!.push(row.answer_source);
      }

      for (const name of NAMES) {
        state.answers[name]!.sort();
      }

      return state;
    }

    /** The whole `up` half, the way dbmate runs it. */
    async function applyRepair() {
      await runner.query(migrationSection(REPAIR_MIGRATION, 'up'));
    }

    let before: State;
    let after: State;
    let again: State;
    let orphanEdge: string | null | undefined;

    beforeAll(async () => {
      await runner.query('SAVEPOINT repair_fixtures');

      await insertQuestion({ id: q.handOrigin, label: 'hand entry origin', evidenceClass: 'hand_entry' });
      await insertQuestion({ id: q.traceableOrigin, label: 'traceable origin' });
      await insertQuestion({
        id: q.deletedOrigin,
        label: 'origin to be deleted',
        evidenceClass: 'hand_entry',
      });

      await insertQuestion({
        id: q.brokenFork,
        label: 'broken fork',
        privateTo: ownerId,
        forkedFrom: q.handOrigin,
      });
      await insertQuestion({
        id: q.othersBrokenFork,
        label: 'somebody else’s broken fork',
        privateTo: otherId,
        forkedFrom: q.handOrigin,
      });
      await insertQuestion({
        id: q.rightFork,
        label: 'fork that is already hand entry',
        evidenceClass: 'hand_entry',
        privateTo: thirdId,
        forkedFrom: q.handOrigin,
      });
      await insertQuestion({
        id: q.traceableFork,
        label: 'fork of a traceable question',
        privateTo: ownerId,
        forkedFrom: q.traceableOrigin,
      });
      await insertQuestion({
        id: q.strictFork,
        label: 'fork stricter than its origin',
        evidenceClass: 'hand_entry',
        privateTo: otherId,
        forkedFrom: q.traceableOrigin,
      });
      await insertQuestion({
        id: q.orphan,
        label: 'fork of a deleted origin',
        privateTo: ownerId,
        forkedFrom: q.deletedOrigin,
      });

      // ON DELETE SET NULL: the fork survives and loses the edge that said what it was.
      await runner.query('DELETE FROM ci.questions WHERE question_id = $1', [q.deletedOrigin]);

      const [edge] = (await runner.query(
        'SELECT forked_from_question_id FROM ci.questions WHERE question_id = $1',
        [q.orphan],
      )) as Array<{ forked_from_question_id: string | null }>;

      orphanEdge = edge?.forked_from_question_id;

      // Every answer source on the repaired fork: only the inference is a guess.
      for (const source of ['user_input', 'inferred', 'observed', 'imported'] as const) {
        await insertAnswer(q.brokenFork, ownerId, source);
      }

      await insertAnswer(q.othersBrokenFork, otherId, 'inferred');
      // Guesses on rows the repair has no business touching.
      await insertAnswer(q.rightFork, thirdId, 'inferred');
      await insertAnswer(q.traceableFork, ownerId, 'inferred');
      await insertAnswer(q.strictFork, otherId, 'inferred');
      await insertAnswer(q.orphan, ownerId, 'inferred');
      await insertAnswer(q.handOrigin, thirdId, 'inferred');

      before = await readState();

      await applyRepair();
      after = await readState();

      // dbmate would never run it twice; a re-run by hand has to be harmless.
      await applyRepair();
      again = await readState();
    });

    afterAll(async () => {
      await runner.query('ROLLBACK TO SAVEPOINT repair_fixtures');
      await runner.query('RELEASE SAVEPOINT repair_fixtures');
    });

    it('starts from the defect it repairs, so the cases below are not vacuous', () => {
      expect(orphanEdge).toBeNull();
      expect(before.classes).toEqual({
        handOrigin: 'hand_entry',
        traceableOrigin: 'traceable',
        brokenFork: 'traceable',
        othersBrokenFork: 'traceable',
        rightFork: 'hand_entry',
        traceableFork: 'traceable',
        strictFork: 'hand_entry',
        orphan: 'traceable',
      });
      expect(before.answers.brokenFork).toEqual(['imported', 'inferred', 'observed', 'user_input']);
    });

    it('marks a traceable fork of a hand_entry question hand_entry, whoever owns it, and nothing else', () => {
      expect(after.classes).toEqual({
        // The origin was never in question.
        handOrigin: 'hand_entry',
        traceableOrigin: 'traceable',
        // The defect, on both owners' copies.
        brokenFork: 'hand_entry',
        othersBrokenFork: 'hand_entry',
        // Already right, and a fork of a traceable question, and a fork that is
        // stricter than its origin: none of them moves, and none is loosened.
        rightFork: 'hand_entry',
        traceableFork: 'traceable',
        strictFork: 'hand_entry',
        // No edge left to say what it was a copy of.
        orphan: 'traceable',
      });
    });

    it('deletes the machine-written answers on the rows it repaired, and nothing the owner or an import wrote', () => {
      expect(after.answers).toEqual({
        handOrigin: ['inferred'],
        traceableOrigin: [],
        // The inference goes; what was typed, observed or imported stays.
        brokenFork: ['imported', 'observed', 'user_input'],
        othersBrokenFork: [],
        // Not repaired, so not purged either.
        rightFork: ['inferred'],
        traceableFork: ['inferred'],
        strictFork: ['inferred'],
        orphan: ['inferred'],
      });
    });

    it('changes nothing the second time it runs', () => {
      expect(again).toEqual(after);
    });
  });
});
