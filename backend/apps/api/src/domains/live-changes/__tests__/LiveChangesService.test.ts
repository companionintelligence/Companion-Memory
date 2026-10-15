import { EventEmitter } from 'node:events';

import type { Client } from 'pg';
import type { DataSource } from 'typeorm';

import { SYSTEM_USER } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { LIVE_CHANGES_CHANNEL, LiveChangesService } from '../services/LiveChangesService';

jest.mock('@ci/common/roles', () => ({ serves: () => true }));

class FakeClient extends EventEmitter {
  connect = jest.fn(async () => undefined);

  query = jest.fn(async () => undefined);

  end = jest.fn(async () => undefined);
}

/** The service with the socket swapped for a fake: everything else is real. */
class TestableLiveChangesService extends LiveChangesService {
  clients: FakeClient[] = [];

  /** How many of the next connects refuse, as a down database would. */
  refuseConnects = 0;

  protected override createClient(): Client {
    const client = new FakeClient();

    if (this.refuseConnects > 0) {
      this.refuseConnects -= 1;
      client.connect.mockRejectedValue(new Error('ECONNREFUSED'));
    }

    this.clients.push(client);

    return client as unknown as Client;
  }
}

function makeService() {
  const dataSource = { query: jest.fn(async () => undefined) };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const service = new TestableLiveChangesService(
    dataSource as unknown as DataSource,
    logger as unknown as LoggerService,
  );

  return { service, dataSource, logger };
}

describe('LiveChangesService', () => {
  describe('publish', () => {
    it('sends one NOTIFY carrying the user and the topic', async () => {
      const { service, dataSource } = makeService();

      await service.publish('alice', 'tasks');

      expect(dataSource.query).toHaveBeenCalledWith('SELECT pg_notify($1, $2)', [
        LIVE_CHANGES_CHANNEL,
        JSON.stringify({ userId: 'alice', topic: 'tasks' }),
      ]);
    });

    it('is a no-op for the system user, who has no sessions to tell', async () => {
      const { service, dataSource } = makeService();

      await service.publish(SYSTEM_USER, 'calendar');
      await service.publish('', 'calendar');

      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('logs and swallows a failed notify — the write it describes already happened', async () => {
      const { service, dataSource, logger } = makeService();
      dataSource.query.mockRejectedValueOnce(new Error('connection reset'));

      await expect(service.publish('alice', 'tasks')).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        'Live change notify failed',
        expect.objectContaining({ topic: 'tasks' }),
      );
    });
  });

  describe('subscribe / dispatch', () => {
    it("delivers a change to every listener of that user and nobody else's", () => {
      const { service } = makeService();
      const alice1 = jest.fn();
      const alice2 = jest.fn();
      const bob = jest.fn();
      service.subscribe('alice', alice1);
      service.subscribe('alice', alice2);
      service.subscribe('bob', bob);

      service.dispatch(JSON.stringify({ userId: 'alice', topic: 'calendar' }));

      expect(alice1).toHaveBeenCalledWith('calendar');
      expect(alice2).toHaveBeenCalledWith('calendar');
      expect(bob).not.toHaveBeenCalled();
    });

    it('stops delivering after unsubscribe and forgets an empty user', () => {
      const { service } = makeService();
      const listener = jest.fn();
      const unsubscribe = service.subscribe('alice', listener);

      unsubscribe();
      service.dispatch(JSON.stringify({ userId: 'alice', topic: 'tasks' }));

      expect(listener).not.toHaveBeenCalled();
      expect(service.subscriberCount).toBe(0);
    });

    it('drops a payload that is not JSON or not a known topic, with a warning', () => {
      const { service, logger } = makeService();
      const listener = jest.fn();
      service.subscribe('alice', listener);

      service.dispatch('not json');
      service.dispatch(JSON.stringify({ userId: 'alice', topic: 'everything' }));
      service.dispatch(JSON.stringify({ topic: 'tasks' }));
      service.dispatch(undefined);

      expect(listener).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(3);
    });

    it('keeps going when one listener throws', () => {
      const { service } = makeService();
      const bad = jest.fn(() => {
        throw new Error('boom');
      });
      const good = jest.fn();
      service.subscribe('alice', bad);
      service.subscribe('alice', good);

      service.dispatch(JSON.stringify({ userId: 'alice', topic: 'tasks' }));

      expect(good).toHaveBeenCalledWith('tasks');
    });
  });

  describe('the listening connection', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('LISTENs on the channel and dispatches what arrives', async () => {
      const { service } = makeService();
      const listener = jest.fn();
      service.subscribe('alice', listener);

      await service.onModuleInit();

      const [client] = service.clients;
      expect(client.connect).toHaveBeenCalled();
      expect(client.query).toHaveBeenCalledWith(`LISTEN ${LIVE_CHANGES_CHANNEL}`);

      client.emit('notification', {
        channel: LIVE_CHANGES_CHANNEL,
        payload: JSON.stringify({ userId: 'alice', topic: 'tasks' }),
      });
      client.emit('notification', {
        channel: 'something_else',
        payload: JSON.stringify({ userId: 'alice', topic: 'tasks' }),
      });

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('reconnects on a fresh client when the socket ends', async () => {
      const { service } = makeService();
      await service.onModuleInit();
      const [first] = service.clients;

      first.emit('end');
      expect(service.clients).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(1_000);

      expect(service.clients).toHaveLength(2);
      expect(service.clients[1].query).toHaveBeenCalledWith(`LISTEN ${LIVE_CHANGES_CHANNEL}`);
    });

    it('backs off while the connect itself keeps failing, and resets once it succeeds', async () => {
      const { service } = makeService();
      service.refuseConnects = 2;

      await service.onModuleInit();
      expect(service.clients).toHaveLength(1);

      // First retry after 1 s.
      await jest.advanceTimersByTimeAsync(1_000);
      expect(service.clients).toHaveLength(2);

      // Doubled: the second wait is 2 s, so 1 s is not enough.
      await jest.advanceTimersByTimeAsync(1_000);
      expect(service.clients).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(service.clients).toHaveLength(3);
      expect(service.clients[2].query).toHaveBeenCalledWith(`LISTEN ${LIVE_CHANGES_CHANNEL}`);

      // Connected, so the next drop waits the floor again, not 4 s.
      service.clients[2].emit('end');
      await jest.advanceTimersByTimeAsync(1_000);
      expect(service.clients).toHaveLength(4);
    });

    it('closes the connection and stops reconnecting on shutdown', async () => {
      const { service } = makeService();
      await service.onModuleInit();
      const [client] = service.clients;

      await service.onModuleDestroy();
      client.emit('end');
      await jest.advanceTimersByTimeAsync(30_000);

      expect(client.end).toHaveBeenCalled();
      expect(service.clients).toHaveLength(1);
    });
  });
});
