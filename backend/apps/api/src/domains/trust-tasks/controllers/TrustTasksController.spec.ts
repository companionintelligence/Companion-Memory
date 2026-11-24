import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';

import type { FeatureService } from '@ci/common/feature';
import type { LoggerService } from '@ci/common/logging';
import type { RawBodyRequest } from '@ci/common/middleware/BodyParserMiddleware';

import type { EngineReply } from '../engine';
import type { TrustTasksService } from '../TrustTasksService';

import { TrustTasksController } from './TrustTasksController';

const LIMIT = 64 * 1024;

interface Options {
  flags?: Record<string, boolean>;
  ready?: boolean;
  reply?: EngineReply;
  limit?: number;
}

function build(options: Options = {}) {
  const flags = options.flags ?? { 'trust.tasks': true, ask: true };
  const features = {
    isFeatureEnabled: async (name: string) => flags[name] === true,
  } as unknown as FeatureService;

  const received: unknown[] = [];
  const metas: unknown[] = [];
  const service = {
    ready: options.ready ?? true,
    maxBodyBytes: options.limit ?? LIMIT,
    handle: async (document: unknown, _transport: unknown, meta: unknown): Promise<EngineReply> => {
      received.push(document);
      metas.push(meta);

      return options.reply ?? { kind: 'document', status: 200, document: { id: 'reply' } as never };
    },
  } as unknown as TrustTasksService;

  const warnings: string[] = [];
  const logger = {
    setContext: () => undefined,
    warn: (message: string) => void warnings.push(message),
  } as unknown as LoggerService;
  const controller = new TrustTasksController(service, features, logger);
  const statuses: number[] = [];
  const response = { status: (code: number) => void statuses.push(code) } as unknown as Response;

  const post = (rawBody: string | undefined, originalUrl?: string) =>
    controller.receive({ rawBody, originalUrl } as RawBodyRequest, response);

  return { post, received, metas, statuses, warnings };
}

describe('TrustTasksController', () => {
  describe('dark by default', () => {
    const cases: [string, Options][] = [
      ['the trust.tasks flag is off', { flags: { ask: true } }],
      ['the ask flag is off', { flags: { 'trust.tasks': true } }],
      ['both flags are off', { flags: {} }],
      ['the box holds no usable signing key', { ready: false }],
    ];

    for (const [label, options] of cases) {
      it(`answers as a box without the route does — Nest's own 404 — when ${label}`, async () => {
        const { post, received, warnings } = build(options);

        const thrown = await post('{"id":"x"}').catch((error: unknown) => error);

        expect(thrown).toBeInstanceOf(NotFoundException);
        expect((thrown as NotFoundException).getStatus()).toBe(404);
        expect((thrown as NotFoundException).getResponse()).toEqual({
          message: 'Cannot POST /agent/v1/trust-tasks',
          error: 'Not Found',
          statusCode: 404,
        });
        expect(received).toHaveLength(0);
        expect(warnings).toHaveLength(0);
      });
    }

    it('words the 404 from the request URL exactly as Nest does for a route that does not exist', async () => {
      const { post } = build({ flags: {} });

      await expect(post('{}', '/agent/v1/trust-tasks?x=1')).rejects.toThrow(
        new NotFoundException('Cannot POST /agent/v1/trust-tasks?x=1'),
      );
    });

    it('does not read the body when it is dark', async () => {
      const { post, received, metas } = build({ flags: {} });

      await expect(post('not even json')).rejects.toBeInstanceOf(NotFoundException);
      expect(received).toHaveLength(0);
      expect(metas).toHaveLength(0);
    });
  });

  describe('one refusal', () => {
    const uniform = new UnauthorizedException('Invalid token');

    it('for a body that is absent, empty, not JSON, or too large', async () => {
      const { post, received, warnings } = build();

      for (const body of [undefined, '', 'not json', '{"unterminated":', 'x'.repeat(LIMIT + 1)]) {
        await expect(post(body)).rejects.toThrow(uniform);
      }

      expect(received).toHaveLength(0);
      expect(warnings).toHaveLength(5);
    });

    it('for a sender the engine would not authenticate or admit — indistinguishable from the cases above', async () => {
      const { post, statuses } = build({ reply: { kind: 'refused' } });

      await expect(post('{"id":"x"}')).rejects.toThrow(uniform);
      expect(statuses).toEqual([]);
    });
  });

  describe('the size of the body', () => {
    it('is bounded by the largest document any served specification accepts, even for valid JSON', async () => {
      const { post, received } = build({ limit: 100 });

      await expect(post(JSON.stringify({ p: 'x'.repeat(200) }))).rejects.toThrow(
        new UnauthorizedException('Invalid token'),
      );
      expect(received).toHaveLength(0);
    });

    it('is counted in bytes, not characters', async () => {
      const { post, received } = build({ limit: 20 });
      // Sixteen characters, twenty-four bytes: only a byte count refuses it.
      const wide = '{"p":"éééééééé"}';
      expect(wide).toHaveLength(16);
      expect(Buffer.byteLength(wide, 'utf8')).toBe(24);

      await expect(post(wide)).rejects.toBeInstanceOf(UnauthorizedException);
      await post('{"p":"éééééé"}');

      expect(received).toHaveLength(1);
    });

    it('is handed to the engine as the length of the bytes that arrived', async () => {
      const { post, metas } = build();
      const body = '{"id":"é"}';

      await post(body);

      expect(metas).toEqual([{ bytes: Buffer.byteLength(body, 'utf8') }]);
    });

    it('accepts a body of exactly the maximum size', async () => {
      const { post, received } = build();
      const padding = 'x'.repeat(LIMIT - '{"p":""}'.length);

      await post(`{"p":"${padding}"}`);

      expect(received).toHaveLength(1);
    });
  });

  it('hands the parsed body to the engine and returns its document under its status', async () => {
    const { post, received, statuses } = build({
      reply: { kind: 'document', status: 409, document: { id: 'conflict' } as never },
    });

    const result = await post('{"id":"x","payload":{"a":1}}');

    expect(received).toEqual([{ id: 'x', payload: { a: 1 } }]);
    expect(statuses).toEqual([409]);
    expect(result).toEqual({ id: 'conflict' });
  });

  it('answers a document it has already accepted with 204 and nothing in the body (HTTPS binding §4)', async () => {
    const { post, statuses } = build({ reply: { kind: 'absorbed' } });

    const result = await post('{"id":"x"}');

    expect(result).toBeUndefined();
    expect(statuses).toEqual([204]);
  });
});
