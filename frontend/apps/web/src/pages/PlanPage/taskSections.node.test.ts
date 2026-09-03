import { describe, expect, it } from 'vitest';

import {
  addLocalDays,
  compareTasks,
  dueAtFromLocalDate,
  groupIntoSections,
  isOverdue,
  localDateOf,
  openCount,
  sectionFor,
  withAllColumns,
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
    placedOnCalendar: false,
    deferUntil: null,
    completedAt: null,
    parentId: null,
    hasPendingChange: false,
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
      expect(sectionFor(task({ status, dueAt: '2020-01-01T00:00:00Z' }), TODAY, 'UTC')).toEqual({
        column: 'done',
        lane: 'inbox',
      });
    }
  });

  it('files proposed tasks under proposed inbox before date buckets', () => {
    expect(sectionFor(task({ status: 'proposed', dueAt: '2026-01-14T12:00:00Z' }), TODAY, 'UTC')).toEqual({
      column: 'proposed',
      lane: 'inbox',
    });
  });

  it('files tasks with pending confirmation in the proposed inbox', () => {
    expect(sectionFor(task({ dueAt: '2026-01-15T12:00:00Z', hasPendingChange: true }), TODAY, 'UTC')).toEqual(
      { column: 'proposed', lane: 'inbox' },
    );
  });

  it('files a past deadline without a calendar block as unscheduled overdue', () => {
    expect(sectionFor(task({ dueAt: '2026-01-14T12:00:00Z' }), TODAY, 'UTC')).toEqual({
      column: 'unscheduled',
      lane: 'overdue',
    });
  });

  it("files today's deadline without a calendar block as unscheduled upcoming", () => {
    expect(sectionFor(task({ dueAt: '2026-01-15T12:00:00Z' }), TODAY, 'UTC')).toEqual({
      column: 'unscheduled',
      lane: 'upcoming',
    });
  });

  it('files a future deadline without a calendar block as unscheduled upcoming', () => {
    expect(sectionFor(task({ dueAt: '2026-01-16T12:00:00Z' }), TODAY, 'UTC')).toEqual({
      column: 'unscheduled',
      lane: 'upcoming',
    });
  });

  it('files an undated accepted task as unscheduled, not back into Proposed', () => {
    expect(sectionFor(task(), TODAY, 'UTC')).toEqual({
      column: 'unscheduled',
      lane: 'upcoming',
    });
  });

  it('keeps a preferred date without a calendar block in unscheduled', () => {
    expect(sectionFor(task({ scheduledFor: '2026-01-15' }), TODAY, 'UTC')).toEqual({
      column: 'unscheduled',
      lane: 'upcoming',
    });
  });

  it('files a calendar-dated task under scheduled only once it is placed', () => {
    expect(sectionFor(task({ scheduledFor: '2026-01-15', placedOnCalendar: true }), TODAY, 'UTC')).toEqual({
      column: 'scheduled',
      lane: 'upcoming',
    });
  });

  it('uses whichever of deadline and scheduled date comes first, still on the calendar column', () => {
    expect(
      sectionFor(
        task({ dueAt: '2026-01-20T12:00:00Z', scheduledFor: '2026-01-15', placedOnCalendar: true }),
        TODAY,
        'UTC',
      ),
    ).toEqual({ column: 'scheduled', lane: 'upcoming' });
  });

  it('files a missed calendar block as scheduled overdue', () => {
    expect(sectionFor(task({ scheduledFor: '2026-01-14', placedOnCalendar: true }), TODAY, 'UTC')).toEqual({
      column: 'scheduled',
      lane: 'overdue',
    });
  });

  it('hides a deferred task even when it is overdue', () => {
    // Deferring is the user saying "not yet"; nagging them anyway is the bug
    // the defer feature exists to prevent.
    expect(
      sectionFor(task({ dueAt: '2026-01-01T12:00:00Z', deferUntil: '2026-02-01' }), TODAY, 'UTC'),
    ).toEqual({ column: 'proposed', lane: 'proposed_upcoming' });
  });

  it('stops hiding a deferred task once its date arrives', () => {
    expect(sectionFor(task({ dueAt: '2026-01-01T12:00:00Z', deferUntil: TODAY }), TODAY, 'UTC')).toEqual({
      column: 'unscheduled',
      lane: 'overdue',
    });
  });

  it('respects the viewing timezone at the day boundary', () => {
    // 2026-01-15T02:00Z is the 14th in LA (overdue against a 15th "today")
    // and the 15th in Sydney (due today → upcoming).
    const dueAt = '2026-01-15T02:00:00.000Z';

    expect(sectionFor(task({ dueAt }), TODAY, LA)).toEqual({ column: 'unscheduled', lane: 'overdue' });
    expect(sectionFor(task({ dueAt }), TODAY, SYDNEY)).toEqual({
      column: 'unscheduled',
      lane: 'upcoming',
    });
  });
});

describe('isOverdue', () => {
  it('matches the overdue lane and ignores deferred work', () => {
    expect(isOverdue(task({ dueAt: '2026-01-14T12:00:00Z' }), TODAY, 'UTC')).toBe(true);
    expect(isOverdue(task({ dueAt: '2026-01-16T12:00:00Z' }), TODAY, 'UTC')).toBe(false);
    expect(isOverdue(task({ dueAt: '2026-01-01T12:00:00Z', deferUntil: '2026-02-01' }), TODAY, 'UTC')).toBe(
      false,
    );
  });
});

describe('addLocalDays / dueAtFromLocalDate', () => {
  it('shifts a calendar date without UTC drift', () => {
    expect(addLocalDays('2026-01-15', 1)).toBe('2026-01-16');
    expect(addLocalDays('2026-01-31', 1)).toBe('2026-02-01');
  });

  it('places dueAt at local noon so the date survives the timezone', () => {
    const due = dueAtFromLocalDate('2026-01-15');

    expect(localDateOf(new Date(due))).toBe('2026-01-15');
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
  it('orders columns proposed → unscheduled → scheduled → done, with lanes at the bottom of each', () => {
    const sections = groupIntoSections(
      [
        task({ id: '1', status: 'done' }),
        task({ id: '2' }),
        task({ id: '3', dueAt: '2026-01-16T12:00:00Z' }),
        task({ id: '4', dueAt: '2026-01-15T12:00:00Z' }),
        task({ id: '5', dueAt: '2026-01-14T12:00:00Z' }),
        task({ id: '6', status: 'proposed' }),
        task({ id: '7', dueAt: '2026-01-15T12:00:00Z', hasPendingChange: true }),
        task({ id: '8', scheduledFor: '2026-01-16', placedOnCalendar: true }),
        task({ id: '9', scheduledFor: '2026-01-14', placedOnCalendar: true }),
      ],
      TODAY,
      'UTC',
    );

    expect(sections.map((s) => s.key)).toEqual(['proposed', 'unscheduled', 'scheduled', 'done']);
    expect(sections[0].lanes.map((l) => l.key)).toEqual(['inbox']);
    expect(sections[0].lanes[0].tasks.map((t) => t.id)).toEqual(['7', '6']);
    expect(sections[1].lanes.map((l) => l.key)).toEqual(['upcoming', 'overdue']);
    expect(sections[1].lanes[0].tasks.map((t) => t.id)).toEqual(['4', '3', '2']);
    expect(sections[1].lanes[1].tasks.map((t) => t.id)).toEqual(['5']);
    expect(sections[2].lanes.map((l) => l.key)).toEqual(['upcoming', 'overdue']);
    expect(sections[2].lanes[0].tasks.map((t) => t.id)).toEqual(['8']);
    expect(sections[2].lanes[1].tasks.map((t) => t.id)).toEqual(['9']);
    expect(sections[3].tasks.map((t) => t.id)).toEqual(['1']);
  });

  // This case used to assert that a child left NO trace: `tasks` held only the
  // root and the counts were derived from it, so a column of three roots with
  // nine live subtasks read "3". The nesting is still right — `tasks` is the
  // render list and must stay roots-only — but the badges now count what is
  // actually in the column.
  it('nests children under roots but counts them into the column', () => {
    const sections = groupIntoSections(
      [
        task({ id: 'root', dueAt: '2026-01-15T12:00:00Z' }),
        task({ id: 'child', parentId: 'root', dueAt: '2026-01-14T12:00:00Z' }),
      ],
      TODAY,
      'UTC',
    );

    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe('unscheduled');
    expect(sections[0].lanes[0].key).toBe('upcoming');
    expect(sections[0].tasks.map((t) => t.id)).toEqual(['root']);
    expect(sections[0].count).toBe(2);
    expect(sections[0].lanes[0].count).toBe(2);
    expect(sections[0].overdueCount).toBe(1);
  });

  it('counts a whole subtree, not just the first generation', () => {
    const sections = groupIntoSections(
      [
        task({ id: 'root' }),
        task({ id: 'child', parentId: 'root' }),
        task({ id: 'grandchild', parentId: 'child' }),
      ],
      TODAY,
      'UTC',
    );

    expect(sections[0].count).toBe(3);
    expect(sections[0].overdueCount).toBe(0);
  });

  // The worst shape of the same bug: an unchecked, overdue subtask sits in the
  // Done column purely because its parent is done. It is invisible to
  // Unscheduled, and Done used to give no hint it contained live work.
  it('reports live overdue work nested inside the Done column', () => {
    const [done] = groupIntoSections(
      [
        task({ id: 'root', status: 'done' }),
        task({ id: 'child', parentId: 'root', dueAt: '2026-01-14T12:00:00Z' }),
      ],
      TODAY,
      'UTC',
    );

    expect(done.key).toBe('done');
    expect(done.tasks.map((t) => t.id)).toEqual(['root']);
    expect(done.count).toBe(2);
    expect(done.overdueCount).toBe(1);
  });

  it('leaves an orphaned child out of every column, since nothing renders it', () => {
    const sections = groupIntoSections([task({ id: 'orphan', parentId: 'gone' })], TODAY, 'UTC');

    expect(sections).toEqual([]);
  });

  it('does not loop forever on a parentId cycle', () => {
    const sections = groupIntoSections(
      [task({ id: 'a', parentId: 'b' }), task({ id: 'b', parentId: 'a' })],
      TODAY,
      'UTC',
    );

    expect(sections).toEqual([]);
  });

  it('omits empty columns rather than rendering a bare heading', () => {
    const sections = groupIntoSections([task({ dueAt: '2026-01-15T12:00:00Z' })], TODAY, 'UTC');

    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe('unscheduled');
    expect(sections[0].lanes.map((l) => l.key)).toEqual(['upcoming']);
  });

  it('fills missing Plan columns so empty category tabs still render', () => {
    const sections = withAllColumns(
      groupIntoSections([task({ dueAt: '2026-01-15T12:00:00Z' })], TODAY, 'UTC'),
    );

    expect(sections.map((section) => [section.key, section.count])).toEqual([
      ['proposed', 0],
      ['unscheduled', 1],
      ['scheduled', 0],
      ['done', 0],
    ]);
  });

  it('returns nothing for an empty list', () => {
    expect(groupIntoSections([], TODAY, 'UTC')).toEqual([]);
  });

  it('sorts within each lane', () => {
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
        task({ status: 'proposed' }),
        task({ status: 'open', hasPendingChange: true }),
        task({ status: 'done' }),
        task({ status: 'skipped' }),
        task({ status: 'archived' }),
      ]),
    ).toBe(4);
  });
});
