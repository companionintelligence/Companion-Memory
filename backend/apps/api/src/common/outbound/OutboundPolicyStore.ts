import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { setCrashReportsUserEnabled } from '../telemetry';

import {
  OUTBOUND_DEFAULT_ENABLED,
  isOutboundPathKey,
  type OutboundPathKey,
  type OutboundSettingRow,
} from './types';

/**
 * How often each process re-reads `ci.outbound_settings`.
 *
 * Same trade as `JobControlStore`, and the same number: the table has at most
 * four rows, so polling cost is not the question — the question is how long a
 * person waits between flipping a switch and the appliance honouring it in the
 * OTHER process (web and worker are separate processes and only one of them
 * served the PUT). Five seconds is well inside "I toggled it and looked away".
 * The process that served the PUT applies it immediately, without waiting.
 */
const REFRESH_INTERVAL_MS = 5_000;

const SELECT_SETTINGS = `
  SELECT key, enabled, updated_at, updated_by
  FROM ci.outbound_settings
`;

interface SettingsRow {
  key: string;
  enabled: boolean | null;
  updated_at: Date | string | null;
  updated_by: string | null;
}

/**
 * The process-wide, always-synchronous view of `ci.outbound_settings`.
 *
 * ── Why a singleton and not only a Nest provider ───────────────────────────
 *
 * Its readers are scattered across places that cannot all be injected into
 * cheaply or at all: the Sentry hooks in `instrument.ts` run before Nest exists,
 * the unfurl and geocode gates sit on per-row hot paths where an `await` on a
 * settings lookup would put a database round trip in front of every fetch, and
 * the connections controllers are constructed by tests with hand-built
 * dependency lists. So the store keeps a snapshot in memory, refreshes it on a
 * timer, and answers every question synchronously — the shape
 * {@link JobControlStore} established for exactly this reason.
 *
 * ── Degradation ────────────────────────────────────────────────────────────
 *
 * Until {@link configure} runs, and on the first failed read, the snapshot is
 * empty, so every path reads as its shipped default (on) and the appliance
 * behaves as it did before this table existed. A LATER failed read keeps the
 * previous snapshot instead of clearing it: a database blip must not silently
 * turn back on a path the user switched off. (The first-read window, and what it
 * means for crash reports specifically, is written up in
 * `common/telemetry/runtimeGate.ts`.)
 */
class OutboundPolicyStoreImpl {
  private dataSource: DataSource | null = null;

  private readonly logger = new Logger('OutboundPolicyStore');

  private snapshot = new Map<OutboundPathKey, OutboundSettingRow>();

  private refreshTimer: NodeJS.Timeout | null = null;

  /**
   * Bumped by every local write. A refresh remembers the value it started at
   * and discards its result if it moved: without this, a poll that read the old
   * row just before a PUT landed would overwrite the PUT's immediate update with
   * stale data, and the switch would appear to bounce back for up to a poll.
   */
  private localWrites = 0;

  /** Logged once, not once per poll, when the migration has not been applied. */
  private warnedMissingTable = false;

  /**
   * Bind the store to the app DataSource and start the poll.
   *
   * Returns the first refresh so the boot hook can await it and have the user's
   * choice live before the appliance starts serving. Callers that do not care
   * can ignore it — the timer keeps going either way.
   */
  configure(dataSource: DataSource | null): Promise<void> {
    this.dataSource = dataSource;

    this.stopTimer();

    if (!dataSource) {
      this.snapshot = new Map();
      this.localWrites += 1;
      this.publish();

      return Promise.resolve();
    }

    // `unref` so a poll timer can never be the thing keeping a CLI script or a
    // finished test process alive.
    this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();

    return this.refresh();
  }

  /** Stop polling. Used at shutdown and by tests. */
  stop(): void {
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Re-read the table. A failure leaves the previous snapshot in place. */
  async refresh(): Promise<void> {
    const dataSource = this.dataSource;

    if (!dataSource) {
      return;
    }

    const startedAt = this.localWrites;

    let rows: SettingsRow[];

    try {
      rows = await dataSource.query<SettingsRow[]>(SELECT_SETTINGS);
    } catch (err: unknown) {
      this.warnOnce(err);

      return;
    }

    if (this.localWrites !== startedAt || this.dataSource !== dataSource) {
      return;
    }

    const next = new Map<OutboundPathKey, OutboundSettingRow>();

    for (const row of rows) {
      const parsed = toRow(row);

      if (parsed) {
        next.set(parsed.key, parsed);
      }
    }

    this.snapshot = next;
    this.publish();
  }

  /**
   * Record a change this process just wrote, so it is enforced now rather than
   * at the next poll. Other processes converge on their own poll.
   */
  applyLocal(row: OutboundSettingRow): void {
    this.localWrites += 1;
    this.snapshot = new Map(this.snapshot).set(row.key, row);
    this.publish();
  }

  /**
   * Whether the USER's setting leaves this path on. Absent row, or a row with no
   * opinion, is the shipped default.
   *
   * Deliberately says nothing about operator kill switches (`CI_TELEMETRY`,
   * `UNFURL_ENABLED`, ...): those are enforced where they always were, and the
   * API layers them on top via `outboundLockedReason`. This is the question
   * every enforcement point asks.
   */
  isEnabled(key: OutboundPathKey): boolean {
    return this.snapshot.get(key)?.enabled ?? OUTBOUND_DEFAULT_ENABLED;
  }

  row(key: OutboundPathKey): OutboundSettingRow | undefined {
    return this.snapshot.get(key);
  }

  /**
   * Push the parts of the snapshot that something outside this module reads
   * through its own flag. Today that is one thing: `instrument.ts` runs before
   * Nest and cannot import this store's state any other way.
   */
  private publish(): void {
    setCrashReportsUserEnabled(this.isEnabled('crash_reports'));
  }

  private warnOnce(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);

    if (/outbound_settings/.test(message) && /does not exist/.test(message)) {
      if (!this.warnedMissingTable) {
        this.warnedMissingTable = true;
        this.logger.warn(
          'ci.outbound_settings is missing — the outbound-path switches are inert until that migration ' +
            'is applied. Every path runs with its shipped default (on).',
        );
      }

      return;
    }

    this.logger.warn('Failed to read ci.outbound_settings', err instanceof Error ? err.stack : message);
  }
}

/**
 * Parse one database row, discarding anything the CHECK constraint should have
 * made impossible. A key this build does not know is a row from a newer schema,
 * and inventing a meaning for it is how a switch comes to mean the opposite of
 * what the user chose.
 */
function toRow(row: SettingsRow): OutboundSettingRow | null {
  if (!isOutboundPathKey(row.key)) {
    return null;
  }

  return {
    key: row.key,
    enabled: typeof row.enabled === 'boolean' ? row.enabled : null,
    updatedAt:
      row.updated_at == null
        ? null
        : row.updated_at instanceof Date
          ? row.updated_at
          : new Date(row.updated_at),
    updatedBy: row.updated_by ?? null,
  };
}

export const OutboundPolicyStore = new OutboundPolicyStoreImpl();

/**
 * The one question every enforcement point asks. A thin alias so a call site
 * reads as what it is deciding rather than as which class holds the answer.
 */
export function isOutboundEnabled(key: OutboundPathKey): boolean {
  return OutboundPolicyStore.isEnabled(key);
}
