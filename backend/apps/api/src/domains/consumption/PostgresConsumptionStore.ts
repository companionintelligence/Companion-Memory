import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';

import type { ConsumptionStore } from './ConsumptionStore';
import { checkSlidingWindow, type RateLimitDecision } from './slidingWindow';


/**
 * Postgres-backed {@link ConsumptionStore} — the one that actually closes G8.
 *
 * Shared across every api replica, and durable across restarts, so a limit of
 * 10/min means ten and a claimed nonce stays claimed.
 */
@Injectable()
export class PostgresConsumptionStore implements ConsumptionStore {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PostgresConsumptionStore.name);
  }

  /**
   * ═══ THE UPSERT IS A LOCK, AND THE OBVIOUS SPELLING IS A RACE ═══
   *
   * The natural way to write this is `INSERT ... ON CONFLICT DO NOTHING`, then
   * `SELECT ... FOR UPDATE`. It is wrong, and wrong in a way that only appears
   * under contention:
   *
   *   `DO NOTHING` does not block on a conflicting uncommitted insert — it
   *   skips. So the losing transaction proceeds to its `SELECT`, which under
   *   READ COMMITTED cannot see the winner's uncommitted row, finds nothing,
   *   treats the window as empty, and then updates zero rows. The hit is
   *   silently dropped and the caller is granted an allowance that was already
   *   spent.
   *
   * `ON CONFLICT DO UPDATE` does block: it takes a row lock on the conflicting
   * row and waits for the other transaction to commit. So the no-op
   * self-assignment below is not redundant — it is the entire concurrency
   * control. It also RETURNS the current `hits` in the same statement, so the
   * read cannot be separated from the lock by another statement.
   *
   * The lock is held to COMMIT, which is why the update below is inside the
   * same transaction rather than a second call.
   */
  async takeWindow(params: {
    key: string;
    now: number;
    windowMs: number;
    max: number;
  }): Promise<RateLimitDecision> {
    return this.dataSource.transaction(async (manager) => {
      const locked: { hits: string[] | null }[] = await manager.query(
        `INSERT INTO ci.consumption_windows (key, hits)
         VALUES ($1, '{}')
         ON CONFLICT (key) DO UPDATE SET updated_at = ci.consumption_windows.updated_at
         RETURNING hits`,
        [params.key],
      );

      // `bigint[]` arrives as strings — the driver will not narrow a 64-bit
      // type to a JS number on its own, and epoch milliseconds are well inside
      // Number.MAX_SAFE_INTEGER, so the conversion is lossless here.
      const previous = (locked[0]?.hits ?? []).map(Number);

      const { kept, decision } = checkSlidingWindow(previous, params.now, params.windowMs, params.max);

      await manager.query(
        `UPDATE ci.consumption_windows SET hits = $2::bigint[], updated_at = NOW() WHERE key = $1`,
        [params.key, kept],
      );

      return decision;
    });
  }

  /**
   * ═══ ONE STATEMENT, AND THE `WHERE` IS THE EXPIRY RULE ═══
   *
   * A bare `ON CONFLICT DO NOTHING` would make a nonce unclaimable FOREVER
   * rather than for its window, so the table would grow without bound and an
   * honest caller unlucky enough to generate a colliding nonce months later
   * would be refused.
   *
   * `DO UPDATE ... WHERE expires_at <= now` gives the exact semantics instead:
   *
   *   - no row            -> inserted, RETURNING yields a row  -> true
   *   - row, expired      -> reclaimed, RETURNING yields a row -> true
   *   - row, still live   -> update skipped, nothing returned  -> false
   *
   * All three in a single statement, so there is no window between the check
   * and the claim for a concurrent caller to slip through.
   */
  async claimOnce(params: { key: string; now: number; expiresAtMs: number }): Promise<boolean> {
    try {
      const claimed: unknown[] = await this.dataSource.query(
        `INSERT INTO ci.consumed_nonces (key, expires_at)
         VALUES ($1, to_timestamp($2::double precision / 1000))
         ON CONFLICT (key) DO UPDATE
           SET expires_at = EXCLUDED.expires_at
           WHERE ci.consumed_nonces.expires_at <= to_timestamp($3::double precision / 1000)
         RETURNING key`,
        [params.key, params.expiresAtMs, params.now],
      );

      return claimed.length > 0;
    } catch (error) {
      // FAIL CLOSED. Refusing an honest request is recoverable; admitting a
      // replayed one is not, and this is the replay defence.
      this.logger.warn(`nonce claim failed, refusing the request: ${String(error)}`);

      return false;
    }
  }

  /**
   * Drop state nobody can still be using.
   *
   * Windows are reaped by IDLENESS rather than by content: a window whose hits
   * have all aged out is indistinguishable from one that was never used, and
   * `updated_at` is the only thing that says whether the key is still live.
   * `olderThanMs` must therefore exceed the longest window any caller uses, or
   * this would delete state that is still being counted against.
   */
  async sweep(now: Date, olderThanMs: number): Promise<{ windows: number; nonces: number }> {
    const cutoff = new Date(now.getTime() - olderThanMs);

    const windows: [unknown[], number] = await this.dataSource.query(
      `DELETE FROM ci.consumption_windows WHERE updated_at < $1`,
      [cutoff],
    );
    const nonces: [unknown[], number] = await this.dataSource.query(
      `DELETE FROM ci.consumed_nonces WHERE expires_at < $1`,
      [now],
    );

    return { windows: windows[1] ?? 0, nonces: nonces[1] ?? 0 };
  }
}
