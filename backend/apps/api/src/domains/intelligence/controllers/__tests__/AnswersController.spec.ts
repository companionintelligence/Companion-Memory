import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';

import { ContextService } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { AnswerService } from '../../services/AnswerService';
import { AnswersController } from '../AnswersController';

/**
 * What `POST /answers` and `PATCH /answers/:id` will take as the answer's text,
 * driven through a real Nest HTTP stack.
 *
 * The web editor stops at 5,000 characters, but a client that does not is the
 * case the server's rule exists for — on an iPhone a 5,003-character run was
 * accepted by the field whole — so the rule is pinned here, at the edge, rather
 * than assumed from the schema's source. `JwtOrApiKeyAuthGuard` is overridden to
 * pass: whether a caller is signed in is that guard's own contract.
 */

const USER = '00000000-0000-4000-8000-0000000000aa';
const QUESTION = '00000000-0000-4000-8000-0000000000b1';
const ANSWER = '00000000-0000-4000-8000-0000000000c1';

/**
 * Spelled out rather than imported: the web editor (`ANSWER_MAX_LENGTH` in
 * LifeDetailsSection.tsx) mirrors this number by hand, so a change to it here
 * should be a red test, not a quiet drift.
 */
const LIMIT = 5000;

class AlwaysAllowGuard {
  canActivate = () => true;
}

describe('AnswersController — the text it accepts', () => {
  let app: INestApplication;
  const create = jest.fn(async (_context: unknown, data: { text: string }) => ({
    id: ANSWER,
    answer: data.text,
  }));
  const update = jest.fn(async (_context: unknown, id: string, data: { text?: string }) => ({
    id,
    answer: data.text,
  }));

  beforeEach(async () => {
    create.mockClear();
    update.mockClear();

    const module = await Test.createTestingModule({
      controllers: [AnswersController],
      providers: [{ provide: AnswerService, useValue: { create, update } }],
    })
      .overrideGuard(JwtOrApiKeyAuthGuard)
      .useClass(AlwaysAllowGuard)
      .compile();

    app = module.createNestApplication();

    // Stands in for RequestContextMiddleware: `@Context()` reads the request
    // context out of AsyncLocalStorage, and `toServiceContext` 401s without it.
    app.use((_req: Request, _res: Response, next: NextFunction) => {
      ContextService.run({ traceId: 'test-trace', userId: USER }, () => next());
    });

    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (text: unknown) =>
    request(app.getHttpServer())
      .post('/answers')
      .send({ text, question: { id: QUESTION } });

  const patch = (body: unknown) =>
    request(app.getHttpServer())
      .patch(`/answers/${ANSWER}`)
      .send(body as object);

  describe('POST /answers', () => {
    it('stores an answer of exactly the limit', async () => {
      await post('a'.repeat(LIMIT)).expect(201);

      expect(create).toHaveBeenCalledTimes(1);
    });

    it('refuses one character over with a 400 that says why, and stores nothing', async () => {
      const response = await post('a'.repeat(LIMIT + 1)).expect(400);

      expect(response.body.errors).toEqual([
        expect.objectContaining({ message: 'Answer text must be 5000 characters or less' }),
      ]);
      expect(create).not.toHaveBeenCalled();
    });

    it('counts UTF-16 units, as the editor does: 2,500 emoji fit, 2,501 do not', async () => {
      await post('😀'.repeat(2500)).expect(201);
      await post('😀'.repeat(2501)).expect(400);

      expect(create).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['empty', ''],
      ['spaces', '   '],
      ['whitespace of every kind', ' \n\t\r\n '],
    ])(
      'refuses a %s answer with a 400 — the CHECK constraint would have made it a 500',
      async (_name, text) => {
        const response = await post(text).expect(400);

        expect(response.body.errors).toEqual([
          expect.objectContaining({ message: 'Answer text is required' }),
        ]);
        expect(create).not.toHaveBeenCalled();
      },
    );

    it('stores the text as sent, not trimmed', async () => {
      await post('  Thai  ').expect(201);

      expect(create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ text: '  Thai  ' }));
    });
  });

  describe('PATCH /answers/:id', () => {
    it('takes an edit of exactly the limit', async () => {
      await patch({ text: 'a'.repeat(LIMIT) }).expect(200);

      expect(update).toHaveBeenCalledTimes(1);
    });

    it('refuses an edit one character over with a 400, and rewrites nothing', async () => {
      const response = await patch({ text: 'a'.repeat(LIMIT + 1) }).expect(400);

      expect(response.body.errors).toEqual([
        expect.objectContaining({ message: 'Answer text must be 5000 characters or less' }),
      ]);
      expect(update).not.toHaveBeenCalled();
    });

    it('refuses a blank edit', async () => {
      await patch({ text: '   ' }).expect(400);

      expect(update).not.toHaveBeenCalled();
    });
  });
});
