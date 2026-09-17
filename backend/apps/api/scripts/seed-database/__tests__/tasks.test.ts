import * as eventsData from '../data/events';
import { TASKS } from '../data/tasks';
import { findMaxDate } from '../date-shifter';

/**
 * The seeded Plan board is the appliance's default landing page, and it shipped
 * with 243 calendar events beside zero tasks. These pin the two properties that
 * make the demo set worth having at all: it covers every board column, and it
 * survives the date shifter in one piece.
 */
describe('seed tasks', () => {
  it("has a task for each of Plan's four columns", () => {
    // Mirrors taskSections.ts: proposed status → Proposed; a live task with a
    // planned block → Scheduled on calendar; a live task without one →
    // Unscheduled; done → Done.
    expect(TASKS.filter((task) => task.status === 'proposed')).toHaveLength(1);
    expect(TASKS.filter((task) => task.complete)).toHaveLength(1);
    expect(TASKS.filter((task) => task.status !== 'proposed' && !task.complete && task.block)).toHaveLength(
      1,
    );
    expect(TASKS.filter((task) => task.status !== 'proposed' && !task.complete && !task.block)).toHaveLength(
      1,
    );
  });

  /**
   * A manually added task never enters the Proposed column's review inbox, so a
   * `manual` source here would leave the Accept / Dismiss affordance — the whole
   * point of that column — unreachable in a demo.
   */
  it('surfaces the proposed task as automation, not as a manual add', () => {
    const proposed = TASKS.find((task) => task.status === 'proposed');

    expect(proposed?.sourceKind).toBeDefined();
    expect(proposed?.sourceKind).not.toBe('manual');
  });

  it('gives the unscheduled task an estimate, which is what the placer needs', () => {
    const unscheduled = TASKS.find((task) => task.status === 'open' && !task.block && !task.complete);

    expect(unscheduled?.estimatedMinutes).toBeGreaterThan(0);
  });

  /**
   * `main.ts` pins the newest date in the corpus to yesterday and shifts tasks
   * by that same delta while deliberately leaving them out of the max. Author a
   * task at or before the anchor and it lands in the past — a Plan board where
   * everything is already overdue. Events carry the corpus's newest dates, so
   * they are the anchor.
   */
  it('is authored past the corpus anchor, so the shift leaves it ahead of today', () => {
    const anchor = findMaxDate(eventsData);

    expect(anchor).not.toBeNull();

    for (const task of TASKS) {
      const authored = findMaxDate([task]);

      if (authored != null) {
        expect(authored.getTime()).toBeGreaterThan(anchor!.getTime());
      }
    }
  });

  it('uses distinct ids, so a re-seed updates rather than collides', () => {
    expect(new Set(TASKS.map((task) => task.id)).size).toBe(TASKS.length);
  });
});
