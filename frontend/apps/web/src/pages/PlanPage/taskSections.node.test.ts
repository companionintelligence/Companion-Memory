import { describe, expect, it } from 'vitest';

import {
  compareTasks,
  groupIntoSections,
  localDateOf,
  openCount,
  sectionFor,
  type SectionedTask,
} from './taskSections';

const LA = 'America/Los_Angeles';
const SYDNEY = 'Australia/Sydney';
const TODAY = '2026-01-15';

function task(overrides: Partial<SectionedTask> = {}): SectionedTask {
  return {
    id: 'task-1',
    title: 'Task',
    status: 'open',
    priority: 3,
    dueAt: null,
    scheduledFor: null,
    deferUntil: null,
    completedAt: null,
    ...overrides,
  };
}

describe('localDateOf', () => {
  it('returns the user-local date, not the UTC date', () => {
    // 02:00Z on the 15th is still the 14th in Los Angeles. Using
    // toISOString().slice(0,10) here would show tomorrow's work all afternoon.
    const instant = new Date('2026-01-15T02:00:00.000Z');

    expect(localDateOf(instant, LA)).toBe('2026-01-14');
    expect(localDateOf(instant, 'UTC')).toBe('2026-01-15');
    expect(localDateOf(instant, SYDNEY)).toBe('2026-01-15');
  });

  it('is stable across local midnight', () => {
    expect(localDateOf(new Date('2026-01-15T07:59:00.000Z'), LA)).toBe('2026-01-14');
    expect(localDateOf(new Date('2026-01-15T08:00:00.000Z'), LA)).toBe('2026-01-15');
  });

  it('zero-pads, so lexicographic date comparison is safe', () => {
    expect(localDateOf(new Date('2026-03-05T12:00:00.000Z'), 'UTC')).toBe('2026-03-05');
  });
});

describe('sectionFor', () => {
  it('files finished work under done regardless of dates', () => {
    for (const status of ['done', 'skipped', 'archived']) {
      expect(sectionFor(task({ status, dueAt: '2020-01-01T00:00:00Z' }), TODAY, 'UTC')).toBe('done');
    }
  });

  it('files a past deadline as overdue', () => {
    expect(sectionFor(task({ dueAt: '2026-01-14T12:00:00Z' }), TODAY, 'UTC')).toBe('overdue');
  });

  it("files today's deadline as today", () => {
    expect(sectionFor(task({ dueAt: '2026-01-15T12:00:00Z' }), TODAY, 'UTC')).toBe('today');
  });

  it('files a future deadline as upcoming', () => {
    expect(sectionFor(task({ dueAt: '2026-01-16T12:00:00Z' }), TODAY, 'UTC')).toBe('upcoming');
  });

  it('files an undated task as someday', () => {
    expect(sectionFor(task(), TODAY, 'UTC')).toBe('someday');
  });

  it('uses scheduledFor when there is no deadline', () => {
    expect(sectionFor(task({ scheduledFor: '2026-01-15' }), TODAY, 'UTC')).toBe('today');
  });

  it('uses whichever of deadline and scheduled date comes first', () => {
    expect(
      sectionFor(task({ dueAt: '2026-01-20T12:00:00Z', scheduledFor: '2026-01-15' }), TODAY, 'UTC'),
    ).toBe('today');
  });

  it('hides a deferred task even when it is overdue', () => {
    // Deferring is the user saying "not yet"; nagging them anyway is the bug
    // the defer feature exists to prevent.
    expect(sectionFor(task({ dueAt: '2026-01-01T12:00:00Z', deferUntil: '2026-02-01' }), TODAY, 'UTC')).toBe(
      'someday',
    );
  });

  it('stops hiding a deferred task once its date arrives', () => {
    expect(sectionFor(task({ dueAt: '2026-01-01T12:00:00Z', deferUntil: TODAY }), TODAY, 'UTC')).toBe(
      'overdue',
    );
  });

  it('respects the viewing timezone at the day boundary', () => {
    // 2026-01-15T02:00Z is the 14th in LA (overdue against a 15th "today")
    // and the 15th in Sydney (due today).
    const dueAt = '2026-01-15T02:00:00.000Z';

    expect(sectionFor(task({ dueAt }), TODAY, LA)).toBe('overdue');
    expect(sectionFor(task({ dueAt }), TODAY, SYDNEY)).toBe('today');
  });
});

describe('compareTasks', () => {
  it('sorts by deadline first', () => {
    const sorted = [
      task({ id: 'b', dueAt: '2026-01-20T00:00:00Z' }),
      task({ id: 'a', dueAt: '2026-01-10T00:00:00Z' }),
    ].sort(compareTasks);

    expect(sorted.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('sorts undated tasks last', () => {
    const sorted = [task({ id: 'undated' }), task({ id: 'dated', dueAt: '2026-01-20T00:00:00Z' })].sort(
      compareTasks,
    );

    expect(sorted.map((t) => t.id)).toEqual(['dated', 'undated']);
  });

  it('breaks deadline ties by priority, then title', () => {
    const due = '2026-01-15T00:00:00Z';
    const sorted = [
      task({ id: 'z', title: 'Zebra', priority: 1, dueAt: due }),
      task({ id: 'a', title: 'Apple', priority: 1, dueAt: due }),
      task({ id: 'urgent', title: 'Mango', priority: 0, dueAt: due }),
    ].sort(compareTasks);

    expect(sorted.map((t) => t.id)).toEqual(['urgent', 'a', 'z']);
  });
});

describe('groupIntoSections', () => {
  it('orders sections overdue → today → upcoming → someday → done', () => {
    const sections = groupIntoSections(
      [
        task({ id: '1', status: 'done' }),
        task({ id: '2' }),
        task({ id: '3', dueAt: '2026-01-16T12:00:00Z' }),
        task({ id: '4', dueAt: '2026-01-15T12:00:00Z' }),
        task({ id: '5', dueAt: '2026-01-14T12:00:00Z' }),
      ],
      TODAY,
      'UTC',
    );

    expect(sections.map((s) => s.key)).toEqual(['overdue', 'today', 'upcoming', 'someday', 'done']);
  });

  it('omits empty sections rather than rendering a bare heading', () => {
    const sections = groupIntoSections([task({ dueAt: '2026-01-15T12:00:00Z' })], TODAY, 'UTC');

    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe('today');
  });

  it('returns nothing for an empty list', () => {
    expect(groupIntoSections([], TODAY, 'UTC')).toEqual([]);
  });

  it('sorts within each section', () => {
    const [section] = groupIntoSections(
      [
        task({ id: 'later', dueAt: '2026-01-15T18:00:00Z' }),
        task({ id: 'earlier', dueAt: '2026-01-15T09:00:00Z' }),
      ],
      TODAY,
      'UTC',
    );

    expect(section.tasks.map((t) => t.id)).toEqual(['earlier', 'later']);
  });

  it('does not mutate the input array', () => {
    const tasks = [
      task({ id: 'b', dueAt: '2026-01-15T18:00:00Z' }),
      task({ id: 'a', dueAt: '2026-01-15T09:00:00Z' }),
    ];

    groupIntoSections(tasks, TODAY, 'UTC');

    expect(tasks.map((t) => t.id)).toEqual(['b', 'a']);
  });
});

describe('openCount', () => {
  it('counts only work that still wants doing', () => {
    expect(
      openCount([
        task({ status: 'open' }),
        task({ status: 'in_progress' }),
        task({ status: 'done' }),
        task({ status: 'skipped' }),
        task({ status: 'archived' }),
      ]),
    ).toBe(2);
  });
});
