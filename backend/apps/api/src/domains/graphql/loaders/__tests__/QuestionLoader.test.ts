import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { Question, QuestionService } from '@ci/domains/intelligence';

import { QuestionLoader } from '../QuestionLoader';

/**
 * `AnswerType.question` is resolved through this loader, and it is what puts the
 * question at the top of the provenance drawer — the heading over an answer, its
 * confidence, its reasoning sentence and the messages it was read out of.
 *
 * DataLoader pairs a batch result with its keys BY POSITION. `findByIds` is an
 * `IN (...)` lookup, so it returns rows in the planner's order and omits ids it
 * cannot see. Those two facts together captioned five real answers on this
 * appliance with four other answers' questions — "I follow hockey." under "What
 * city were you born in?" — so these tests give the service back a deliberately
 * wrong order and a hole, which is exactly what Postgres does.
 */
function question(id: string, text: string): Question {
  return { id, text } as Question;
}

function makeLoader(rows: Question[]) {
  const findByIds = jest.fn(async (_context: unknown, ids: string[]) =>
    // Deliberately NOT in key order, and silently short: the two properties of
    // a real `IN (...)` that the loader has to survive.
    rows.filter((row) => ids.includes(row.id)).reverse(),
  );

  const logger = { setContext: jest.fn(), log: jest.fn() } as unknown as LoggerService;
  const loader = new QuestionLoader({ findByIds } as unknown as QuestionService, logger);

  return { loader, findByIds, context: {} as UserServiceContext };
}

describe('QuestionLoader', () => {
  it('returns each question to the key that asked for it, not to its position in the result', async () => {
    const rows = [
      question('q-born', 'What city were you born in?'),
      question('q-sport', 'What sports do you follow?'),
      question('q-food', 'What is your favorite cuisine?'),
    ];
    const { loader, context } = makeLoader(rows);

    const loaded = await Promise.all([
      loader.load(context, 'q-sport'),
      loader.load(context, 'q-born'),
      loader.load(context, 'q-food'),
    ]);

    expect(loaded.map((row) => row?.text)).toEqual([
      'What sports do you follow?',
      'What city were you born in?',
      'What is your favorite cuisine?',
    ]);
  });

  it('gives a key with no row null instead of shifting every later key onto the wrong question', async () => {
    // A question that was deleted, or is private to another user, is absent from
    // the result. Positional zipping turns that hole into a one-place shift for
    // everything after it — every later answer captioned with its neighbour's.
    const { loader, context } = makeLoader([
      question('q-born', 'What city were you born in?'),
      question('q-food', 'What is your favorite cuisine?'),
    ]);

    const loaded = await Promise.all([
      loader.load(context, 'q-born'),
      loader.load(context, 'q-gone'),
      loader.load(context, 'q-food'),
    ]);

    expect(loaded.map((row) => row?.text ?? null)).toEqual([
      'What city were you born in?',
      null,
      'What is your favorite cuisine?',
    ]);
  });

  it('still batches the whole page into one query', async () => {
    const { loader, findByIds, context } = makeLoader([question('q-born', 'Where?')]);

    await Promise.all([loader.load(context, 'q-born'), loader.load(context, 'q-born')]);

    expect(findByIds).toHaveBeenCalledTimes(1);
  });
});
