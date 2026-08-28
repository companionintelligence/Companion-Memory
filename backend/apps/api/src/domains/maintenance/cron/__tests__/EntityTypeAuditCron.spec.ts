import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';

import type { LoggerService } from '@ci/common/logging';

import type { EntityTypeAuditResult, EntityTypeAuditService } from '../../services/EntityTypeAuditService';
import { ENTITY_TYPE_AUDIT_CRON, EntityTypeAuditCron } from '../EntityTypeAuditCron';

const noopLogger = {
  setContext: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

function registeredOptions(): { cronTime?: string; name?: string } {
  return (Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, EntityTypeAuditCron.prototype.auditEntityTypes) ??
    {}) as {
    cronTime?: string;
    name?: string;
  };
}

describe('EntityTypeAuditCron schedule', () => {
  // Read from the metadata the scheduler is actually handed, not from the
  // exported constant: a `@Cron` rewritten to a five-field expression or to a
  // `CronExpression.EVERY_*` preset fails here too.
  it('registers under an explicit name, so ci.cron_runs and the dashboard agree', () => {
    expect(registeredOptions().name).toBe('EntityTypeAuditCron.auditEntityTypes');
  });

  it('fires weekly, off second 0', () => {
    const fields = (registeredOptions().cronTime ?? '').trim().split(/\s+/);

    expect(fields).toHaveLength(6);
    expect(fields[0]).toBe('23');
    // Sunday only — the whole point of a weekly audit is that it is not nightly.
    expect(fields.slice(1).join(' ')).toBe('35 5 * * 0');
    expect(ENTITY_TYPE_AUDIT_CRON).toBe(fields.join(' '));
  });
});

describe('EntityTypeAuditCron.sweep', () => {
  const users = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

  const dataSource = {
    query: async () => users.map((id) => ({ id })),
  } as never;

  const result = (proposed: number): EntityTypeAuditResult => ({
    userId: '',
    examined: proposed,
    findings: proposed,
    proposed,
    records: [],
  });

  it('audits every onboarded user', async () => {
    const seen: string[] = [];
    const service = {
      audit: async (userId: string) => {
        seen.push(userId);

        return result(1);
      },
    } as unknown as EntityTypeAuditService;

    await expect(new EntityTypeAuditCron(dataSource, service, noopLogger).sweep()).resolves.toBe(2);
    expect(seen).toEqual(users);
  });

  it('does not let one account lose the week for the rest', async () => {
    const service = {
      audit: async (userId: string) => {
        if (userId === users[0]) {
          throw new Error('boom');
        }

        return result(3);
      },
    } as unknown as EntityTypeAuditService;

    await expect(new EntityTypeAuditCron(dataSource, service, noopLogger).sweep()).resolves.toBe(3);
  });
});
