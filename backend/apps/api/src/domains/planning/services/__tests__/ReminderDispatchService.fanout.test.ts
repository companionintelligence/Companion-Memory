import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DataSource } from 'typeorm';

import {
  claimDueReminders,
  listUsersWithDueReminders,
  REMINDER_LEASE_MINUTES,
  REMINDER_MAX_ATTEMPTS,
} from '../ReminderDispatchService';

/**
 * The cron's audience query must ask for every row the claim would take.
 * It once asked only for `status = 'pending'`, so retries and expired leases
 * were never fanned out and the claim that handles them never ran — while the
 * claim's own tests, which call it directly, stayed green.
 *
 * These pin the SQL text. The same cases are proved against a real Postgres in
 * `ReminderDispatchService.claim.integration.test.ts`.
 */
function capture(result: unknown): { dataSource: DataSource; query: jest.Mock } {
  const query = jest.fn(async () => result);

  return { dataSource: { query } as unknown as DataSource, query };
}

async function fanOutSql(): Promise<string> {
  const { dataSource, query } = capture([]);

  await listUsersWithDueReminders(dataSource, new Date());

  return String(query.mock.calls[0][0]);
}

async function claimSql(): Promise<string> {
  const { dataSource, query } = capture([[], 0]);

  await claimDueReminders(dataSource, 'user-1', new Date());

  return String(query.mock.calls[0][0]);
}

const squash = (sql: string) => sql.replace(/\s+/g, ' ');

describe('listUsersWithDueReminders', () => {
  it('fans out a failed reminder whose retry is due', async () => {
    const sql = squash(await fanOutSql());

    expect(sql).toContain(
      `r.status = 'failed' AND r.attempts < ${REMINDER_MAX_ATTEMPTS} AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= $1)`,
    );
  });

  it('fans out a delivering reminder whose lease has expired', async () => {
    const sql = squash(await fanOutSql());

    expect(sql).toContain(
      `r.status = 'delivering' AND r.claimed_at < $1::timestamptz - interval '${REMINDER_LEASE_MINUTES} minutes'`,
    );
  });

  it('still fans out a due pending reminder', async () => {
    const sql = squash(await fanOutSql());

    expect(sql).toContain(`r.status = 'pending'`);
    expect(sql).toContain('r.fire_at <= $1');
  });

  it('never fans out a device-mode reminder', async () => {
    const sql = squash(await fanOutSql());

    expect(sql).toContain(`r.delivery_mode = 'push'`);
  });

  it('keeps the onboarded, not-deleted audience', async () => {
    const sql = squash(await fanOutSql());

    expect(sql).toContain('u.onboarded = true');
    expect(sql).toContain('u.deleted_at IS NULL');
  });

  it('asks the same readiness question as the claim', async () => {
    const fanOut = squash(await fanOutSql())
      .replace(/\br\./g, '')
      .replace(/\$1/g, '$NOW');
    const claim = squash(await claimSql()).replace(/\$2/g, '$NOW');
    const readiness = claim.slice(claim.indexOf("delivery_mode = 'push'"), claim.indexOf(' AND (task_id'));

    expect(readiness.length).toBeGreaterThan(0);
    expect(fanOut).toContain(readiness);
  });

  it('returns the user ids the query names', async () => {
    const { dataSource } = capture([{ userId: 'user-a' }, { userId: 'user-b' }]);

    await expect(listUsersWithDueReminders(dataSource, new Date())).resolves.toEqual(['user-a', 'user-b']);
  });
});

describe('reminders_dispatch_due_idx', () => {
  // The partial index only serves the query if Postgres can prove the query's
  // WHERE implies the index predicate, which needs one status per query arm
  // and the same literal attempt limit on both sides.
  it('covers every arm of the fan-out with the same attempt limit', () => {
    const migration = readFileSync(
      join(__dirname, '../../../../../db/postgres/migrations/20261124044550_reminder_delivery_retry.sql'),
      'utf8',
    );
    const index = squash(
      migration.slice(migration.indexOf('CREATE INDEX IF NOT EXISTS reminders_dispatch_due_idx')),
    );

    expect(index).toContain(
      `WHERE delivery_mode = 'push' AND (status IN ('pending', 'delivering') OR (status = 'failed' AND attempts < ${REMINDER_MAX_ATTEMPTS}));`,
    );
  });
});
