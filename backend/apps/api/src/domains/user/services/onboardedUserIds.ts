import type { DataSource } from 'typeorm';

/**
 * The audience for recurring per-user background work: every account that
 * finished FTUE and has not been deleted, oldest first.
 *
 * This is the id-only twin of {@link UserService.findAllOnboarded}, for the
 * fan-out crons that only need ids and already hold a `DataSource`. It exists
 * because five of them carried their own copy of
 * `SELECT id FROM ci.users WHERE onboarded = true` — and none of those copies
 * filtered `deleted_at`. `UserEntity` soft-deletes through a `@DeleteDateColumn`,
 * which TypeORM's `find` honours and a raw query does not, and deletion never
 * clears `onboarded`; so an account in its purge grace period kept receiving
 * every sidecar run, derivation, audit and merge those crons enqueue, while the
 * crons that went through the repository correctly skipped it.
 *
 * Oldest-first for the same reason `findAllOnboarded` orders that way: "the
 * first account" has to mean one thing everywhere.
 */
export async function listOnboardedUserIds(dataSource: DataSource): Promise<string[]> {
  const rows = (await dataSource.query(
    `SELECT id
       FROM ci.users
      WHERE onboarded = true
        AND deleted_at IS NULL
      ORDER BY created_at ASC`,
  )) as Array<{ id: string }>;

  return rows.map((row) => String(row.id));
}
