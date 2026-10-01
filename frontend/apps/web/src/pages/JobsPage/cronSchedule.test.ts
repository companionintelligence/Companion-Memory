import { describe, expect, it } from 'vitest';

import { createDateTimeFormatter, DEVICE_DATE_TIME_FORMATTER, type TimeFormat } from '@/lib/dateTimeFormat';

import { describeCronExpression } from './cronSchedule';

/** Terser assertion: "frequency | when". */
const read = (expression: string, fmt = DEVICE_DATE_TIME_FORMATTER) => {
  const s = describeCronExpression(expression, fmt);

  return s.when ? `${s.frequency} | ${s.when}` : s.frequency;
};

const cycle = (timeFormat: TimeFormat) =>
  createDateTimeFormatter({ timeFormat, timeZone: 'Pacific/Auckland' });

describe('describeCronExpression', () => {
  it('reads the expressions this appliance actually registers', () => {
    // Every one of these is live on a running box — the point of the column is
    // that these become legible without counting fields.
    expect(read('0 */15 * * * *')).toBe('Every 15 min');
    expect(read('*/1 * * * *')).toBe('Every minute');
    expect(read('0 10 * * * *')).toBe('Hourly | at :10');
    expect(read('0 25 4 * * *')).toBe('Daily | at 04:25');
    expect(read('0 30 2 * * *')).toBe('Daily | at 02:30');
    expect(read('0 15 0 * * 1')).toBe('Weekly | Mon at 00:15');
    expect(read('0 20 0 1 * *')).toBe('Monthly | 1st at 00:20');
  });

  it('handles second-level steps (six-field crons start at seconds)', () => {
    expect(read('*/30 * * * * *')).toBe('Every 30 sec');
  });

  it('handles hour steps, keeping the minute offset', () => {
    expect(read('0 20 */2 * * *')).toBe('Every 2 hr | at :20');
    expect(read('0 0 */5 * * *')).toBe('Every 5 hr | at :00');
  });

  it('accepts five-field expressions written by hand', () => {
    expect(read('10 * * * *')).toBe('Hourly | at :10');
    expect(read('0 3 * * *')).toBe('Daily | at 03:00');
  });

  it('says "every minute" when the minute is a wildcard under a fixed hour', () => {
    // Firing 60 times must not read as if it runs once.
    expect(read('0 * 3 * * *')).toBe('Every minute');
  });

  it('pads every entry of a minute list', () => {
    // `:0,20,40` reads as one strange number; three firings need three times.
    expect(read('0 0,20,40 * * * *')).toBe('Hourly | at :00, :20, :40');
    expect(read('0 7,27,47 * * * *')).toBe('Hourly | at :07, :27, :47');
  });

  it('keeps the second offset that staggers otherwise-identical schedules', () => {
    // These three are the same frequency on purpose and staggered on purpose.
    // Dropping the offset would render them identically.
    expect(read('0 */5 * * * *')).toBe('Every 5 min');
    expect(read('20 */5 * * * *')).toBe('Every 5 min | +20s');
    expect(read('30 */5 * * * *')).toBe('Every 5 min | +30s');
  });

  it('handles a range-with-step like 0-23/1, and reads a step of 1 as the plain unit', () => {
    // Five fields: minute 0, hour 0-23/1 — every hour on the hour.
    expect(read('0 0-23/1 * * *')).toBe('Hourly | at :00');
    expect(read('*/1 * * * * *')).toBe('Every second');
  });

  it('ordinalises the day of month correctly', () => {
    expect(read('0 0 0 2 * *')).toBe('Monthly | 2nd at 00:00');
    expect(read('0 0 0 3 * *')).toBe('Monthly | 3rd at 00:00');
    expect(read('0 0 0 11 * *')).toBe('Monthly | 11th at 00:00');
    expect(read('0 0 0 21 * *')).toBe('Monthly | 21st at 00:00');
  });

  it('degrades gracefully rather than throwing on nonsense', () => {
    expect(read('')).toBe('—');
    expect(read('not a cron')).toBe('—');
    expect(describeCronExpression(null, DEVICE_DATE_TIME_FORMATTER).frequency).toBe('—');
  });

  it('always carries the raw expression through', () => {
    expect(describeCronExpression('0 */15 * * * *', DEVICE_DATE_TIME_FORMATTER).raw).toBe('0 */15 * * * *');
  });

  it("writes a fixed time in the chosen hour cycle, on the cron's own clock", () => {
    // 'auto' keeps the cron-style reading every row has always had.
    expect(read('0 25 16 * * *', cycle('auto'))).toBe('Daily | at 16:25');
    // A forced cycle applies here like everywhere else — and the profile zone does not, since
    // this is a wall-clock field of the expression rather than an instant.
    expect(read('0 25 16 * * *', cycle('h12'))).toMatch(/^Daily \| at 4:25\sPM$/i);
    expect(read('0 25 4 * * *', cycle('h23'))).toMatch(/^Daily \| at 0?4:25$/);
    expect(read('0 15 0 * * 1', cycle('h12'))).toMatch(/^Weekly \| Mon at 12:15\sAM$/i);
    // Minute-only readings have no hour to cycle.
    expect(read('0 10 * * * *', cycle('h12'))).toBe('Hourly | at :10');
    // A list has no single time to write.
    expect(read('0 0 0,12 * * *', cycle('h12'))).toBe('Daily | at 0,12:00');
  });
});
