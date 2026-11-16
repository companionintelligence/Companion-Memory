import { EventEmitter } from 'node:events';

import type { Request, Response } from 'express';

import type { RequestContext } from '@ci/common/context';
import type { GuardedRequest } from '@ci/common/guards/guardRequest';

import {
  COALESCE_MS,
  HEARTBEAT_MS,
  LiveChangesController,
  streamCredentialOf,
} from '../controllers/LiveChangesController';
import type { LiveChangeListener, LiveChangesService } from '../services/LiveChangesService';

type FakeRes = Response & { written: string[] };

function makeRes(): FakeRes {
  const emitter = new EventEmitter();
  const written: string[] = [];
  const state = { ended: false };
  const fake = {
    written,
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    get writableEnded() {
      return state.ended;
    },
    writeHead: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn((chunk: string) => {
      written.push(chunk);

      return true;
    }),
    end: jest.fn(() => {
      state.ended = true;
    }),
    status: jest.fn(),
    socket: { setNoDelay: jest.fn() },
  };
  fake.status.mockReturnValue(fake);

  return fake as unknown as FakeRes;
}

function makeController() {
  let listener: LiveChangeListener | null = null;
  let onRevoked: (() => void) | null = null;
  const unsubscribe = jest.fn();
  const unsubscribeRevocations = jest.fn();
  const service = {
    subscribe: jest.fn((_userId: string, next: LiveChangeListener) => {
      listener = next;

      return unsubscribe;
    }),
    subscribeRevocations: jest.fn((_userId: string, next: () => void) => {
      onRevoked = next;

      return unsubscribeRevocations;
    }),
    isCredentialLive: jest.fn(async () => true),
  };
  const controller = new LiveChangesController(service as unknown as LiveChangesService);

  return {
    controller,
    service,
    unsubscribe,
    unsubscribeRevocations,
    emit: (topic: 'tasks' | 'calendar') => listener?.(topic),
    revoke: () => onRevoked?.(),
  };
}

/** An unsigned JWT: the guard verified the real one, the stream only reads its claims. */
function fakeJwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}.signature`;
}

/** A request as the guard leaves it: an emitter for `close`, with the fields a strategy set. */
function makeReq(fields: Partial<GuardedRequest> = {}): EventEmitter & GuardedRequest {
  return Object.assign(new EventEmitter(), { headers: {} }, fields) as unknown as EventEmitter &
    GuardedRequest;
}

describe('LiveChangesController', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('opens an event stream for the signed-in user', () => {
    const { controller, service } = makeController();
    const req = new EventEmitter() as EventEmitter & Request;
    const res = makeRes();

    controller.changes({ userId: 'alice' } as RequestContext, req, res);

    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'Content-Type': 'text/event-stream' }),
    );
    expect(service.subscribe).toHaveBeenCalledWith('alice', expect.any(Function));
    expect(res.written[0]).toMatch(/^retry: \d+\n/);
  });

  it('coalesces a burst on one topic into a single frame, per topic', () => {
    const { controller, emit } = makeController();
    const req = new EventEmitter() as EventEmitter & Request;
    const res = makeRes();
    controller.changes({ userId: 'alice' } as RequestContext, req, res);
    res.written.length = 0;

    emit('tasks');
    emit('tasks');
    emit('calendar');
    emit('tasks');
    jest.advanceTimersByTime(COALESCE_MS);

    expect(res.written).toEqual([
      'event: change\ndata: {"topic":"tasks"}\n\n',
      'event: change\ndata: {"topic":"calendar"}\n\n',
    ]);
  });

  it('keeps the stream warm with a comment frame', () => {
    const { controller } = makeController();
    const req = new EventEmitter() as EventEmitter & Request;
    const res = makeRes();
    controller.changes({ userId: 'alice' } as RequestContext, req, res);
    res.written.length = 0;

    jest.advanceTimersByTime(HEARTBEAT_MS);

    expect(res.written).toEqual([': ping\n\n']);
  });

  it('unsubscribes, stops the timers and ends the response when the client leaves', () => {
    const { controller, unsubscribe, emit } = makeController();
    const req = new EventEmitter() as EventEmitter & Request;
    const res = makeRes();
    controller.changes({ userId: 'alice' } as RequestContext, req, res);
    emit('tasks');

    req.emit('close');
    res.written.length = 0;
    jest.advanceTimersByTime(HEARTBEAT_MS * 2);

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(res.end).toHaveBeenCalled();
    expect(res.written).toEqual([]);
  });

  it('refuses a context with no user rather than streaming to nobody', async () => {
    const { controller, service } = makeController();
    const req = new EventEmitter() as EventEmitter & Request;
    const res = makeRes();

    await expect(controller.changes({} as RequestContext, req, res)).rejects.toThrow();
    expect(service.subscribe).not.toHaveBeenCalled();
  });

  describe('when what opened it no longer lets it in', () => {
    it('ends when the access token it was opened with expires', async () => {
      const { controller, unsubscribe, unsubscribeRevocations } = makeController();
      const exp = Math.floor(Date.now() / 1000) + 60;
      const res = makeRes();
      await controller.changes(
        { userId: 'alice' } as RequestContext,
        makeReq({ headers: { authorization: `Bearer ${fakeJwt({ sub: 'alice', exp })}` } }),
        res,
      );

      jest.advanceTimersByTime(59_000);
      expect(res.end).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1_000);
      expect(res.end).toHaveBeenCalled();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(unsubscribeRevocations).toHaveBeenCalledTimes(1);
    });

    it('ends at once when a revoke notice finds its key gone', async () => {
      const { controller, service, revoke } = makeController();
      const res = makeRes();
      await controller.changes({ userId: 'alice' } as RequestContext, makeReq({ apiKeyId: 'key-1' }), res);

      service.isCredentialLive.mockResolvedValue(false);
      revoke();
      await jest.advanceTimersByTimeAsync(0);

      expect(service.isCredentialLive).toHaveBeenCalledWith('alice', { kind: 'apiKey', keyId: 'key-1' });
      expect(res.end).toHaveBeenCalled();
    });

    it('checks again on each keep-alive and ends once the session is signed out', async () => {
      const { controller, service } = makeController();
      const res = makeRes();
      const exp = Math.floor(Date.now() / 1000) + 300;
      await controller.changes(
        { userId: 'alice' } as RequestContext,
        makeReq({ headers: { authorization: `Bearer ${fakeJwt({ sub: 'alice', sid: 'sess-1', exp })}` } }),
        res,
      );

      await jest.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect(res.end).not.toHaveBeenCalled();

      service.isCredentialLive.mockResolvedValue(false);
      await jest.advanceTimersByTimeAsync(HEARTBEAT_MS);

      expect(service.isCredentialLive).toHaveBeenLastCalledWith('alice', {
        kind: 'session',
        sessionId: 'sess-1',
      });
      expect(res.end).toHaveBeenCalled();
    });

    it('asks again when a notice lands while a check is still out', async () => {
      const { controller, service, revoke } = makeController();
      const res = makeRes();
      await controller.changes({ userId: 'alice' } as RequestContext, makeReq({ apiKeyId: 'key-1' }), res);

      // The keep-alive's check read the key before the revoke was written.
      let answer: (live: boolean) => void = () => undefined;
      service.isCredentialLive.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      );
      jest.advanceTimersByTime(HEARTBEAT_MS);
      service.isCredentialLive.mockResolvedValue(false);
      revoke();
      answer(true);
      await jest.advanceTimersByTimeAsync(0);

      expect(service.isCredentialLive).toHaveBeenCalledTimes(2);
      expect(res.end).toHaveBeenCalled();
    });

    it('keeps the stream when the check itself fails', async () => {
      const { controller, service, revoke } = makeController();
      const res = makeRes();
      await controller.changes({ userId: 'alice' } as RequestContext, makeReq({ apiKeyId: 'key-1' }), res);

      service.isCredentialLive.mockRejectedValue(new Error('connection reset'));
      revoke();
      await jest.advanceTimersByTimeAsync(HEARTBEAT_MS);

      expect(res.end).not.toHaveBeenCalled();
    });

    it('refuses to open for a session that was already signed out, so a closed stream does not come back', async () => {
      const { controller, service } = makeController();
      service.isCredentialLive.mockResolvedValue(false);
      const res = makeRes();

      await controller.changes(
        { userId: 'alice' } as RequestContext,
        makeReq({ headers: { authorization: `Bearer ${fakeJwt({ sub: 'alice', sid: 'sess-1' })}` } }),
        res,
      );

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.writeHead).not.toHaveBeenCalled();
      expect(service.subscribe).not.toHaveBeenCalled();
    });
  });
});

describe('streamCredentialOf', () => {
  it('names the key a key stream was opened with, which never expires on its own', () => {
    expect(streamCredentialOf(makeReq({ apiKeyId: 'key-1' }))).toEqual({
      credential: { kind: 'apiKey', keyId: 'key-1' },
      expiresAt: null,
    });
  });

  it('ties our own access token to its session and times it by its expiry', () => {
    const req = makeReq({
      headers: { authorization: `Bearer ${fakeJwt({ sub: 'alice', sid: 'sess-1', exp: 100 })}` },
    });

    expect(streamCredentialOf(req)).toEqual({
      credential: { kind: 'session', sessionId: 'sess-1' },
      expiresAt: 100_000,
    });
  });

  it("does not take a Portal token's sid for one of our sessions", () => {
    const req = makeReq({
      headers: { authorization: `Bearer ${fakeJwt({ sub: 'alice', sid: 'portal-session', exp: 100 })}` },
      portalPrincipal: { admin: false },
    });

    expect(streamCredentialOf(req)).toEqual({ credential: { kind: 'token' }, expiresAt: 100_000 });
  });

  it('treats a token with no session, or no readable claims, as good until it expires', () => {
    expect(
      streamCredentialOf(makeReq({ headers: { authorization: `Bearer ${fakeJwt({ sub: 'alice' })}` } })),
    ).toEqual({
      credential: { kind: 'token' },
      expiresAt: null,
    });
    expect(streamCredentialOf(makeReq({ headers: { authorization: 'Bearer not-a-jwt' } }))).toEqual({
      credential: { kind: 'token' },
      expiresAt: null,
    });
  });
});
