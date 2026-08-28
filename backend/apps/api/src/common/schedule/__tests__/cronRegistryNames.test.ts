import fs from 'node:fs';
import path from 'node:path';

import { SchedulerType } from '@nestjs/schedule/dist/enums/scheduler-type.enum';
import { SCHEDULE_CRON_OPTIONS, SCHEDULER_TYPE } from '@nestjs/schedule/dist/schedule.constants';

/**
 * The key every `@Cron` on this appliance will register under.
 *
 * `SchedulerOrchestrator.addCron` keys its map on `options.name ||
 * crypto.randomUUID()`, and everything durable about a schedule is a lookup by
 * that string: its `ci.cron_runs` row, the dashboard's last-run cell, firing it
 * by hand from the Jobs page. A `@Cron` with no `name` therefore gets a fresh
 * key on every boot and nothing can ever find it again — the account purge
 * shipped that way and ran invisibly, under a different UUID each restart,
 * because nothing here checked.
 *
 * `addCron` assigns into that map rather than checking for a clash, so two
 * crons sharing a name is not an error either: it is one schedule silently
 * replacing the other at boot, with no log line to say which one lost.
 *
 * Read the way Nest reads it — import the module, which is when the decorator
 * runs, then take the metadata off the prototype method — so this asserts on
 * what the scheduler will be handed rather than on the source text.
 */
const SRC_ROOT = path.resolve(__dirname, '../../..');

/**
 * A name the whole appliance can rely on: the class it lives on, a dot, and an
 * identifier. Excludes the `randomUUID()` fallback by construction — a UUID has
 * no dot, and its leading digits are not an identifier.
 */
const STABLE_NAME = /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/;

interface CronRegistration {
  /** `options.name`, or null when the scheduler would mint a UUID instead. */
  readonly name: string | null;
  /** Class the decorated method is defined on. */
  readonly declaredIn: string;
  readonly method: string;
  readonly file: string;
}

function cronSourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') {
        cronSourceFiles(full, found);
      }

      continue;
    }

    if (
      entry.name.endsWith('.ts') &&
      !/\.(test|spec)\.ts$/.test(entry.name) &&
      fs.readFileSync(full, 'utf8').includes('@Cron(')
    ) {
      found.push(full);
    }
  }

  return found;
}

async function cronRegistrations(): Promise<CronRegistration[]> {
  const registrations: CronRegistration[] = [];
  // One class can surface an inherited method under several exports; the
  // scheduler registers the function once, so count it once.
  const seen = new Set<unknown>();

  for (const file of cronSourceFiles(SRC_ROOT)) {
    const module = (await import(file)) as Record<string, unknown>;

    for (const exported of Object.values(module)) {
      if (typeof exported !== 'function' || typeof exported.prototype !== 'object') {
        continue;
      }

      for (
        let proto: object | null = exported.prototype as object;
        proto && proto !== Object.prototype;
        proto = Object.getPrototypeOf(proto) as object | null
      ) {
        for (const method of Object.getOwnPropertyNames(proto)) {
          const target = Object.getOwnPropertyDescriptor(proto, method)?.value as unknown;

          if (typeof target !== 'function' || seen.has(target)) {
            continue;
          }

          if (Reflect.getMetadata(SCHEDULER_TYPE, target) !== SchedulerType.CRON) {
            continue;
          }

          seen.add(target);

          const options = Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, target) as { name?: string } | undefined;

          registrations.push({
            name: options?.name != null && options.name.length > 0 ? options.name : null,
            declaredIn: (proto.constructor as { name?: string })?.name ?? '(anonymous)',
            method,
            file: path.relative(SRC_ROOT, file),
          });
        }
      }
    }
  }

  return registrations;
}

describe('cron registry names', () => {
  let registrations: CronRegistration[];

  beforeAll(async () => {
    registrations = await cronRegistrations();
  });

  it('finds the appliance’s schedules at all', () => {
    // A floor, not a count: the point is that a walk which quietly stops
    // discovering anything cannot pass the assertions below by finding nothing.
    // The appliance registered 48 across 24 files when this was written.
    expect(registrations.length).toBeGreaterThanOrEqual(40);
  });

  it('gives every cron a name of its own instead of a per-boot UUID', () => {
    const unnamed = registrations
      .filter((registration) => registration.name == null)
      .map(
        (registration) =>
          `${registration.file}: ${registration.declaredIn}.${registration.method} has no { name }`,
      );

    expect(unnamed).toEqual([]);
  });

  it('names each cron after the class it lives on, so the key is greppable', () => {
    const mismatched = registrations
      .filter(
        (registration) =>
          registration.name != null &&
          (!STABLE_NAME.test(registration.name) ||
            registration.name.split('.')[0] !== registration.declaredIn),
      )
      .map(
        (registration) =>
          `${registration.file}: ${registration.declaredIn}.${registration.method} registers as "${registration.name}"`,
      );

    expect(mismatched).toEqual([]);
  });

  it('gives every cron a name no other cron holds', () => {
    const holders = new Map<string, string[]>();

    for (const registration of registrations) {
      if (registration.name == null) {
        continue;
      }

      const sites = holders.get(registration.name) ?? [];

      sites.push(`${registration.file}: ${registration.declaredIn}.${registration.method}`);
      holders.set(registration.name, sites);
    }

    const collisions = [...holders.entries()]
      .filter(([, sites]) => sites.length > 1)
      .map(([name, sites]) => `"${name}" is claimed by ${sites.join(' and ')}`);

    expect(collisions).toEqual([]);
  });
});
