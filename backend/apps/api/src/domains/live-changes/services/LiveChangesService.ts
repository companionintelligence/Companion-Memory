import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Client, type Notification } from 'pg';
import { DataSource } from 'typeorm';

import { SYSTEM_USER } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { serves } from '@ci/common/roles';
import config from '@ci/configuration';

/** The Postgres NOTIFY channel every process publishes on and every api process listens to. */
export const LIVE_CHANGES_CHANNEL = 'ci_live_changes';

/**
 * What a browser can be told has changed. Deliberately coarse: a topic is "go
 * and re-read", not the row that changed. The calendar page re-runs its two
 * queries on either, which is exactly what it does on a page load, so the
 * payload carries nothing a client would have to merge.
 */
export const LIVE_CHANGE_TOPICS = ['tasks', 'calendar'] as const;
export type LiveChangeTopic = (typeof LIVE_CHANGE_TOPICS)[number];

export type LiveChangeListener = (topic: LiveChangeTopic) => void;

interface LiveChangePayload {
  userId: string;
  topic: LiveChangeTopic;
}

const RECONNECT_FLOOR_MS = 1_000;
const RECONNECT_CEILING_MS = 30_000;

function isTopic(value: unknown): value is LiveChangeTopic {
  return typeof value === 'string' && (LIVE_CHANGE_TOPICS as readonly string[]).includes(value);
}

/**
 * Tells every open browser session of a user that something they are looking
 * at has changed, so it re-reads instead of waiting for its next poll.
 *
 * ═══ WHY POSTGRES NOTIFY, NOT THE JOB BUS ═══
 *
 * The writes happen in whichever process did them — the api on a click, the
 * worker on a cron that finishes a task — and the browser's stream is held
 * open by an api process. The pg-boss bus delivers a job to ONE consumer, so
 * it cannot fan a change out to every api process, and its pick-up latency is
 * seconds. `pg_notify` reaches every process that is listening, at once, over
 * the database connection every process already has. The HBPE cache
 * invalidation in `HbpeNotifyService` made the same choice for the same
 * reason; the difference is that here the listener is also in this codebase.
 *
 * Only an api process (`serves('web')`) listens: the worker holds no browser
 * connections, so it has nobody to tell. Every process publishes.
 *
 * A notification that cannot be sent is logged and dropped: the write it
 * describes has already happened, and a page that misses it still refetches
 * on its next poll or on the next return to the tab. The stream is a hint,
 * never the record.
 */
@Injectable()
export class LiveChangesService implements OnModuleInit, OnModuleDestroy {
  private readonly listeners = new Map<string, Set<LiveChangeListener>>();

  private client: Client | null = null;

  private reconnectTimer: NodeJS.Timeout | null = null;

  private reconnectDelay = RECONNECT_FLOOR_MS;

  private stopping = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(LiveChangesService.name);
  }

  async onModuleInit(): Promise<void> {
    if (!serves('web')) {
      return;
    }

    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    await this.disconnect();
  }

  /**
   * Announce a change. `userId` may be the SYSTEM_USER sentinel — a cron
   * acting on nobody in particular — in which case there is no session to
   * tell and this is a no-op.
   */
  async publish(userId: string | typeof SYSTEM_USER, topic: LiveChangeTopic): Promise<void> {
    if (typeof userId !== 'string' || !userId) {
      return;
    }

    const payload: LiveChangePayload = { userId, topic };

    try {
      await this.dataSource.query('SELECT pg_notify($1, $2)', [
        LIVE_CHANGES_CHANNEL,
        JSON.stringify(payload),
      ]);
    } catch (error) {
      this.logger.warn('Live change notify failed', {
        topic,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Hear every change announced for one user. Returns the unsubscribe. */
  subscribe(userId: string, listener: LiveChangeListener): () => void {
    let set = this.listeners.get(userId);

    if (!set) {
      set = new Set();
      this.listeners.set(userId, set);
    }

    set.add(listener);

    return () => {
      const current = this.listeners.get(userId);

      if (!current) {
        return;
      }

      current.delete(listener);

      if (current.size === 0) {
        this.listeners.delete(userId);
      }
    };
  }

  /** How many sessions are listening, across every user. Diagnostics only. */
  get subscriberCount(): number {
    let count = 0;

    for (const set of this.listeners.values()) {
      count += set.size;
    }

    return count;
  }

  /**
   * Exposed so the raw NOTIFY payload path can be tested without a database,
   * and because the listener below is nothing more than this on a socket.
   */
  dispatch(raw: string | undefined): void {
    if (!raw) {
      return;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn('Live change payload is not JSON', { raw: raw.slice(0, 200) });

      return;
    }

    const payload = parsed as Partial<LiveChangePayload> | null;

    if (!payload || typeof payload.userId !== 'string' || !isTopic(payload.topic)) {
      this.logger.warn('Live change payload has the wrong shape', { raw: raw.slice(0, 200) });

      return;
    }

    const set = this.listeners.get(payload.userId);

    if (!set) {
      return;
    }

    for (const listener of set) {
      try {
        listener(payload.topic);
      } catch (error) {
        this.logger.warn('Live change listener threw', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * One dedicated connection, outside the pool. LISTEN is per-session state:
   * a pooled connection would be handed to another query, and TypeORM's pool
   * gives no way to keep one checked out for the life of the process.
   */
  protected createClient(): Client {
    return new Client({
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.db.username,
      password: config.db.password,
      application_name: 'ci-live-changes',
    });
  }

  private async connect(): Promise<void> {
    if (this.stopping) {
      return;
    }

    const client = this.createClient();

    client.on('notification', (message: Notification) => {
      if (message.channel === LIVE_CHANGES_CHANNEL) {
        this.dispatch(message.payload);
      }
    });

    // Both fire on a dropped socket; `end` alone is what a server restart
    // produces. Either way the only right move is to come back.
    client.on('error', (error: Error) => {
      this.logger.warn('Live change listener connection errored', { error: error.message });
      this.scheduleReconnect(client);
    });
    client.on('end', () => {
      this.scheduleReconnect(client);
    });

    try {
      await client.connect();
      await client.query(`LISTEN ${LIVE_CHANGES_CHANNEL}`);
    } catch (error) {
      this.logger.warn('Live change listener could not connect', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleReconnect(client);

      return;
    }

    this.client = client;
    this.reconnectDelay = RECONNECT_FLOOR_MS;
    this.logger.log('Live change listener connected', { channel: LIVE_CHANGES_CHANNEL });
  }

  private scheduleReconnect(from: Client): void {
    if (this.stopping || this.reconnectTimer) {
      return;
    }

    if (this.client === from) {
      this.client = null;
    }

    from.removeAllListeners();
    void from.end().catch(() => undefined);

    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_CEILING_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;

    if (!client) {
      return;
    }

    client.removeAllListeners();

    try {
      await client.end();
    } catch {
      // Already gone; nothing to release.
    }
  }
}
