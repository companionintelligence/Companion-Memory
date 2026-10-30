import { EventEmitter } from 'node:events';

import type { Request, Response } from 'express';

import type { RequestContext } from '@ci/common/context';

import { COALESCE_MS, HEARTBEAT_MS, LiveChangesController } from '../controllers/LiveChangesController';
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
  const unsubscribe = jest.fn();
  const service = {
    subscribe: jest.fn((_userId: string, next: LiveChangeListener) => {
      listener = next;

      return unsubscribe;
    }),
  };
  const controller = new LiveChangesController(service as unknown as LiveChangesService);

  return { controller, service, unsubscribe, emit: (topic: 'tasks' | 'calendar') => listener?.(topic) };
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

  it('refuses a context with no user rather than streaming to nobody', () => {
    const { controller, service } = makeController();
    const req = new EventEmitter() as EventEmitter & Request;
    const res = makeRes();

    expect(() => controller.changes({} as RequestContext, req, res)).toThrow();
    expect(service.subscribe).not.toHaveBeenCalled();
  });
});
