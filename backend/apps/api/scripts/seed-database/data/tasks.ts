import type { CreateTaskDto } from '@ci/domains/planning';

/**
 * A demo task, plus the two things a task row cannot carry itself.
 *
 * `block` is a calendar placement: a planned block is a `ci.events` row, not a
 * task column (see `domains/planning/index.ts`), and its presence — not
 * `scheduledFor` — is what Plan reads to file a card under "Scheduled on
 * calendar". `complete` exists because `completedAt` has no create-time field;
 * `TaskService.complete` is its only writer.
 */
type SeedTask = RequiredFields<CreateTaskDto, 'id'> & {
  block?: { start: Date; end: Date };
  complete?: boolean;
};

/**
 * One task per Plan board column, so a freshly seeded appliance opens on a board
 * that shows what the four columns are for rather than on four empty headings.
 *
 * ═══ WHY THESE DATES LOOK LIKE THEY ARE IN 2026 ═══
 *
 * `main.ts` shifts the whole seed corpus so its newest date lands yesterday.
 * These dates are authored relative to that same anchor — the last seeded event,
 * `2026-02-28T18:00:00Z` — so each one below is really "the anchor plus N days",
 * and after the shift they sit a few days either side of the seeding moment.
 * They are deliberately kept out of `findMaxDate` (see main.ts) so the anchor
 * stays the last event and a task dated past it still lands in the future,
 * which is where plans live.
 */
export const TASKS: SeedTask[] = [
  {
    // Proposed — the trust-dial review inbox, with the Accept / Dismiss pair.
    // `sourceKind` is non-manual because this is what automation surfacing a
    // task out of the corpus looks like; a manual add goes straight to `open`.
    id: 'c1a4f0d2-8e33-4a51-9b17-2f6d0c9a4e71',
    title: "Book the Ojai weekend for Sarah's birthday",
    description: 'Three weeks out, per the note. Check the inn Sarah mentioned before it fills up.',
    status: 'proposed',
    priority: 2,
    dueAt: new Date('2026-03-03T18:00:00Z'),
    sourceKind: 'memory_scan',
    sourceRef: 'seed:sarah-birthday',
  },
  {
    // Unscheduled — accepted work with an estimate but no calendar block yet,
    // which is exactly what the placer picks up.
    id: '5d2b8e47-6c19-4f80-a3d5-71b4e8c02a96',
    title: 'Draft the API latency write-up',
    description: 'Cache misses spike during the standup window. Propose a TTL change with numbers behind it.',
    status: 'open',
    priority: 2,
    estimatedMinutes: 90,
    dueAt: new Date('2026-03-04T18:00:00Z'),
  },
  {
    // Scheduled on calendar — the block below is what draws it on the calendar
    // grid alongside the seeded events. The shift is not a whole number of
    // days, so an authored 18:00Z lands at the seeding moment itself; +2h puts
    // this block just far enough ahead to read as upcoming work.
    id: '9f7c3a15-40b8-4d26-8e93-5ac1d7b06f38',
    title: 'Prep the TechNova roadmap review',
    description: 'Pull the Q1 numbers and the open architecture questions ahead of the sync.',
    status: 'open',
    priority: 1,
    estimatedMinutes: 60,
    block: {
      start: new Date('2026-03-01T20:00:00Z'),
      end: new Date('2026-03-01T21:00:00Z'),
    },
  },
  {
    // Done — the column is otherwise empty on a fresh box, and a board with
    // nothing ever finished reads as a board nothing has ever used.
    id: '3e60d9b4-2f57-4c18-b0a6-8d4915ec72cb',
    title: 'Drop the Tarmac off at the cyclery',
    description: 'Shifting skips in the 3rd cog — they think it is the cassette.',
    status: 'open',
    priority: 3,
    estimatedMinutes: 30,
    complete: true,
  },
];
