import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { ActionEntity } from '@ci/domains/intelligence';
import { flexWindow, PersonalizationService, PlacementService } from '@ci/domains/personalization';
import { HbpeService } from '@ci/domains/predictions';
import { SummaryEntity } from '@ci/domains/summaries';

import { EventCandidateEntity } from '../../entities/EventCandidateEntity';
import { CandidateService } from '../CandidateService';
import { SuggestionSyncService } from '../SuggestionSyncService';

const ctx = { userId: 'user-1' } as UserServiceContext;

function action(overrides: Partial<ActionEntity> = {}): ActionEntity {
  return {
    id: 'act-1',
    title: 'Review goals for Backlog Grooming',
    text: 'Take a moment to review the core objectives of **Backlog Grooming**. It matters.',
    priority: 3,
    dismissed: false,
    ...overrides,
  } as ActionEntity;
}

function insight(overrides: Partial<SummaryEntity> = {}): SummaryEntity {
  return {
    summaryId: 'sum-1',
    title: 'Optimize Meeting Cadence',
    periodType: 'insight',
    dismissed: false,
    content: { key_actions: ['Group related tasks into one block', 'Decline the Thursday sync'] },
    structuredContext: {},
    confidenceScore: 0.6,
    ...overrides,
  } as SummaryEntity;
}

describe('SuggestionSyncService — projecting actions and insights onto the slate', () => {
  let service: SuggestionSyncService;
  let actions: { find: jest.Mock };
  let summaries: { find: jest.Mock };
  let candidates: { find: jest.Mock; save: jest.Mock };
  let candidateService: { upsert: jest.Mock };
  let personalization: { getProfile: jest.Mock };
  let hbpe: { getDueList: jest.Mock };

  async function setup(
    actionRows: ActionEntity[] = [],
    summaryRows: SummaryEntity[] = [],
    dueRows: unknown[] = [],
  ) {
    actions = { find: jest.fn(async () => actionRows) };
    summaries = { find: jest.fn(async () => summaryRows) };
    candidates = { find: jest.fn(async () => []), save: jest.fn(async (e) => e) };
    candidateService = { upsert: jest.fn(async (_c, proposals) => proposals) };
    // autoSchedule off keeps the auto-accept leg out of these projection tests.
    personalization = { getProfile: jest.fn(async () => ({ autoSchedule: false })) };
    hbpe = { getDueList: jest.fn(async () => ({ due: dueRows })) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        SuggestionSyncService,
        { provide: getRepositoryToken(ActionEntity), useValue: actions },
        { provide: getRepositoryToken(SummaryEntity), useValue: summaries },
        { provide: getRepositoryToken(EventCandidateEntity), useValue: candidates },
        { provide: CandidateService, useValue: candidateService },
        { provide: PersonalizationService, useValue: personalization },
        {
          provide: PlacementService,
          useValue: {
            timezoneFor: async () => 'UTC',
            flexWindow,
          },
        },
        { provide: HbpeService, useValue: hbpe },
        { provide: LoggerService, useValue: { setContext: jest.fn(), log: jest.fn(), debug: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(SuggestionSyncService);
  }

  const proposals = () => candidateService.upsert.mock.calls[0]?.[1] ?? [];

  it('projects a live action into a candidate with a stable dedupe key', async () => {
    await setup([action()]);

    await service.sync(ctx);

    const [first] = proposals();
    expect(first.dedupe_key).toBe('action:act-1');
    expect(first.title).toBe('Review goals for Backlog Grooming');
    expect(first.generator).toBe('adapter/action');
  });

  it('stores a week window from midnight and estimates duration instead of stamping 30', async () => {
    await setup([action({ title: 'Plan Your Trip to Japan', text: 'research flights and hotels' })]);

    await service.sync(ctx);

    const [first] = proposals();
    expect(first.duration_minutes).toBe(45);
    expect(first.window_start.getUTCHours()).toBe(0);
    expect(first.window_start.getUTCMinutes()).toBe(0);
    expect(first.window_end.getTime() - first.window_start.getTime()).toBe(7 * 86_400_000);
  });

  it('keeps a because on every projected action', async () => {
    await setup([action()]);

    await service.sync(ctx);

    // Markdown emphasis is stripped and the body clipped to its first sentence.
    expect(proposals()[0].rationale).toBe('Take a moment to review the core objectives of Backlog Grooming.');
  });

  it('falls back to a generic because when the action has no body', async () => {
    await setup([action({ text: null })]);

    await service.sync(ctx);

    expect(proposals()[0].rationale).toBe('Surfaced in your feed.');
  });

  it('maps action priority onto fit so urgent items rank first', async () => {
    await setup([action({ id: 'urgent', priority: 1 }), action({ id: 'idle', priority: 5 })]);

    await service.sync(ctx);

    const [urgent, idle] = proposals();
    expect(urgent.confidence).toBeGreaterThan(idle.confidence);
  });

  it('only asks the repository for undismissed actions', async () => {
    await setup([action()]);

    await service.sync(ctx);

    expect(actions.find.mock.calls[0][0].where).toMatchObject({ dismissed: false });
  });

  it('splits an insight into one candidate per key action', async () => {
    await setup([], [insight()]);

    await service.sync(ctx);

    const rows = proposals();
    expect(rows).toHaveLength(2);
    expect(rows[0].dedupe_key).toBe('insight:sum-1:0');
    expect(rows[1].dedupe_key).toBe('insight:sum-1:1');
  });

  it('points an insight-derived candidate back at the insight that produced it', async () => {
    await setup([], [insight()]);

    await service.sync(ctx);

    expect(proposals()[0].rationale_sources).toEqual([
      { kind: 'insight', id: 'sum-1', note: 'Optimize Meeting Cadence' },
    ]);
  });

  it('uses the "Label: detail" shape key actions are written in', async () => {
    await setup(
      [],
      [insight({ content: { key_actions: ['Pre-Read Prep: Draft a brief two-page document.'] } })],
    );

    await service.sync(ctx);

    const [row] = proposals();
    expect(row.title).toBe('Pre-Read Prep');
    expect(row.description).toBe('Draft a brief two-page document.');
  });

  it('never truncates a long unlabelled action mid-word', async () => {
    const long =
      'Follow up with key stakeholders across engineering and design about the ' +
      'implementation costs and expected return before the session concludes';
    await setup([], [insight({ content: { key_actions: [long] } })]);

    await service.sync(ctx);

    const { title } = proposals()[0];
    expect(title.endsWith('…')).toBe(true);
    // The clip lands on a word boundary, not inside one.
    expect(long.startsWith(title.slice(0, -1))).toBe(true);
    expect(title.slice(0, -1).trim().endsWith(' ')).toBe(false);
  });

  it('reads key_actions from structured_context when content lacks them', async () => {
    await setup([], [insight({ content: {}, structuredContext: { key_actions: ['Book the room'] } })]);

    await service.sync(ctx);

    expect(proposals()).toHaveLength(1);
    expect(proposals()[0].title).toBe('Book the room');
  });

  it('skips blank and non-string key actions rather than proposing empty cards', async () => {
    await setup([], [insight({ content: { key_actions: ['  ', 42, null, 'Real one'] } })]);

    await service.sync(ctx);

    const rows = proposals();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Real one');
  });

  it('tolerates a malformed key_actions payload', async () => {
    await setup([], [insight({ content: { key_actions: 'not-an-array' } })]);

    await expect(service.sync(ctx)).resolves.toBe(0);
  });

  it('retires an open candidate whose source action has since been dismissed', async () => {
    await setup([]);
    candidates.find.mockResolvedValue([
      {
        id: 'cand-1',
        dedupeKey: 'action:gone',
        generator: 'adapter/action',
        status: 'open',
      } as EventCandidateEntity,
    ]);

    await service.sync(ctx);

    const saved = candidates.save.mock.calls[0]?.[0];
    expect(saved.status).toBe('declined');
    expect(saved.feedbackReason).toBe('source_dismissed');
  });

  it('leaves a candidate the user already accepted alone', async () => {
    await setup([]);
    candidates.find.mockResolvedValue([]);

    await service.sync(ctx);

    // findInRange's own filter is `status = 'open'`; nothing else is touched.
    expect(candidates.find.mock.calls[0][0].where).toMatchObject({ status: 'open' });
    expect(candidates.save).not.toHaveBeenCalled();
  });

  /**
   * `feedback_reason` is the consumer's input, and it carries information
   * `status` cannot: a `never` and a `not_like_this` decline both land on
   * `status = 'never'`. These fixtures are deliberately identical apart from
   * the reason, so a suppression keyed on status instead would make the second
   * test below fail.
   *
   * `adapter/insight` + an `insight:` dedupe key keeps retireStale (which only
   * looks at `action:` rows) from mutating them out from under the assertion —
   * the repository mock returns the same rows to every `find`.
   */
  function retiredRow(feedbackReason: string, status: string): EventCandidateEntity {
    return {
      id: 'cand-retired',
      userId: 'user-1',
      title: 'Decline the Thursday sync',
      description: 'Decline the Thursday sync',
      status,
      feedbackReason,
      generator: 'adapter/insight',
      dedupeKey: 'insight:sum-OLD:1',
    } as EventCandidateEntity;
  }

  /** The same two key actions, re-minted under a new summary id. */
  const regenerated = () => insight({ summaryId: 'sum-2' });

  /**
   * A repository `find` that actually honours the `where` it is handed, so
   * these tests can tell "queried by feedback_reason" apart from "queried by
   * status" — the entire distinction this feature turns on. A blanket
   * `mockResolvedValue` hands the row back either way and would prove nothing.
   */
  function findHonouringWhere(rows: EventCandidateEntity[]) {
    return async (options: { where?: Record<string, unknown> } = {}) =>
      rows.filter((row) =>
        Object.entries(options.where ?? {}).every(
          ([key, value]) => (row as unknown as Record<string, unknown>)[key] === value,
        ),
      );
  }

  it('does not re-propose an idea retired with "never", even under a fresh dedupe key', async () => {
    await setup([], [regenerated()]);
    candidates.find.mockImplementation(findHonouringWhere([retiredRow('never', 'never')]));

    await service.sync(ctx);

    const rows = proposals();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Group related tasks into one block');
    expect(rows[0].dedupe_key).toBe('insight:sum-2:0');
  });

  it('keeps proposing an idea declined as "not_like_this" — the idea was right, the framing was not', async () => {
    await setup([], [regenerated()]);
    candidates.find.mockImplementation(findHonouringWhere([retiredRow('not_like_this', 'never')]));

    await service.sync(ctx);

    const rows = proposals();
    expect(rows).toHaveLength(2);
    expect(rows.map((r: { title: string }) => r.title)).toStrictEqual([
      'Group related tasks into one block',
      'Decline the Thursday sync',
    ]);
  });

  it('does not treat "source_dismissed" as a user verdict on the idea', async () => {
    await setup([], [regenerated()]);
    candidates.find.mockImplementation(findHonouringWhere([retiredRow('source_dismissed', 'declined')]));

    await service.sync(ctx);

    expect(proposals()).toHaveLength(2);
  });

  it('does not let a deferral suppress the idea it deferred', async () => {
    await setup([], [regenerated()]);
    candidates.find.mockImplementation(findHonouringWhere([retiredRow('not_now', 'snoozed')]));

    await service.sync(ctx);

    expect(proposals()).toHaveLength(2);
  });

  it('matches a retired idea on its detail too, not just its label', async () => {
    await setup([], [insight({ content: { key_actions: ['Pre-Read Prep: Read the board deck.'] } })]);
    candidates.find.mockImplementation(
      findHonouringWhere([
        {
          ...retiredRow('never', 'never'),
          title: 'Pre-Read Prep',
          description: 'Draft a brief two-page document.',
        } as EventCandidateEntity,
      ]),
    );

    await service.sync(ctx);

    // Same label, different task — retiring one must not retire the other.
    const rows = proposals();
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('Read the board deck.');
  });

  it('asks the repository for retired rows by feedback reason, not by status', async () => {
    await setup([], [regenerated()]);

    await service.sync(ctx);

    // The suppression lookup runs before retireStale's own `find`.
    expect(candidates.find.mock.calls[0][0].where).toStrictEqual({
      userId: 'user-1',
      feedbackReason: 'never',
    });
  });

  it('does not retire candidates that came from an insight', async () => {
    await setup([]);
    candidates.find.mockResolvedValue([
      {
        id: 'cand-2',
        dedupeKey: 'insight:sum-1:0',
        generator: 'adapter/insight',
        status: 'open',
      } as EventCandidateEntity,
    ]);

    await service.sync(ctx);

    expect(candidates.save).not.toHaveBeenCalled();
  });

  it('projects an unscheduled due cluster onto the slate', async () => {
    await setup(
      [],
      [],
      [
        {
          cluster_id: 'clu-1',
          name: 'Standup',
          l0_class: 'WORK',
          last_seen: '2026-08-20',
          days_since_last: 8,
          median_interval_days: 7,
          due_in_days: -1,
          overdue: true,
          scheduled_date: null,
          confidence: 0.8,
        },
        {
          cluster_id: 'clu-2',
          name: 'Already booked',
          l0_class: 'WORK',
          last_seen: '2026-08-27',
          days_since_last: 1,
          median_interval_days: 7,
          due_in_days: 0,
          overdue: false,
          scheduled_date: '2026-08-28',
          confidence: 0.9,
        },
        {
          cluster_id: 'clu-3',
          name: 'Low confidence',
          l0_class: 'WORK',
          last_seen: '2026-07-01',
          days_since_last: 50,
          median_interval_days: 30,
          due_in_days: -10,
          overdue: true,
          scheduled_date: null,
          confidence: 0.2,
        },
      ],
    );

    await service.sync(ctx);

    const due = proposals().filter((p: { generator: string }) => p.generator === 'hbpe/due');
    expect(due).toHaveLength(1);
    expect(due[0].dedupe_key).toBe('due:clu-1:2026-08-20');
    expect(due[0].title).toBe('Standup');
    expect(due[0].l1_cluster_id).toBe('clu-1');
  });
});

/**
 * tryAutoAccept commits calendar time on the user's behalf without a review
 * step for hands_off users above a confidence threshold — every projection
 * test above forces autoSchedule:false specifically to stay out of this path.
 * PersonalizationService.decide is exercised for REAL here (not mocked) so
 * these tests prove the actual gate, not a stand-in for it.
 */
describe('SuggestionSyncService — tryAutoAccept', () => {
  let service: SuggestionSyncService;
  let candidates: { find: jest.Mock; save: jest.Mock };
  let candidateService: { upsert: jest.Mock; accept: jest.Mock };
  let personalization: { getProfile: jest.Mock };

  function openCandidate(overrides: Record<string, unknown> = {}) {
    return {
      id: 'cand-1',
      userId: 'user-1',
      status: 'open',
      confidence: 0.95,
      durationMinutes: 30,
      // What flexWindow actually writes: local midnight of the day the sync ran.
      windowStart: new Date('2026-08-20T00:00:00.000Z'),
      generator: 'adapter/action',
      dedupeKey: 'action:act-1',
      ...overrides,
    } as EventCandidateEntity;
  }

  async function setup(openRows: EventCandidateEntity[], profile: Record<string, unknown>) {
    // A "live" action so proposals.length > 0 (sync() short-circuits before
    // retireStale/tryAutoAccept otherwise) and so retireStale — which also runs
    // in sync() before tryAutoAccept — sees action:act-1 as still live and
    // doesn't mutate the fixtures above out from under this describe block.
    const actions = {
      find: jest.fn(async () => [
        {
          id: 'act-1',
          title: 'Something',
          text: 'Do the thing',
          priority: 3,
          dismissed: false,
        } as ActionEntity,
      ]),
    };
    const summaries = { find: jest.fn(async () => []) };
    candidates = { find: jest.fn(async () => openRows), save: jest.fn(async (e) => e) };
    candidateService = { upsert: jest.fn(async () => []), accept: jest.fn(async () => ({})) };
    personalization = { getProfile: jest.fn(async () => profile) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        SuggestionSyncService,
        { provide: getRepositoryToken(ActionEntity), useValue: actions },
        { provide: getRepositoryToken(SummaryEntity), useValue: summaries },
        { provide: getRepositoryToken(EventCandidateEntity), useValue: candidates },
        { provide: CandidateService, useValue: candidateService },
        { provide: PersonalizationService, useValue: personalization },
        {
          provide: PlacementService,
          useValue: {
            timezoneFor: async () => 'UTC',
            flexWindow,
          },
        },
        { provide: HbpeService, useValue: { getDueList: async () => ({ due: [] }) } },
        { provide: LoggerService, useValue: { setContext: jest.fn(), log: jest.fn(), debug: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(SuggestionSyncService);
  }

  const HANDS_OFF_PROFILE = { trustMode: 'hands_off', autoSchedule: true, autoPromoteThreshold: 0.7 };
  const BALANCED_PROFILE = { trustMode: 'balanced', autoSchedule: false, autoPromoteThreshold: 0.85 };

  /**
   * Mid-afternoon, and the mocked PlacementService resolves the zone as UTC, so
   * every expected instant below is also the user's wall clock. The clock is
   * frozen because the slot these tests are about is derived from it.
   */
  const AFTERNOON = new Date('2026-08-20T14:30:00.000Z');

  /** The start these fixtures should land on: now, plus the five-minute lead. */
  const SOON = new Date('2026-08-20T14:35:00.000Z');

  const acceptedStarts = () => candidateService.accept.mock.calls.map((call) => call[2] as Date);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(AFTERNOON);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('auto-accepts a high-confidence candidate for a hands_off, autoSchedule user', async () => {
    await setup([openCandidate({ confidence: 0.95 })], HANDS_OFF_PROFILE);

    await service.sync(ctx);

    expect(candidateService.accept).toHaveBeenCalledWith(ctx, 'cand-1', SOON);
  });

  /**
   * `window_start` is the earliest EDGE of the seven-day flex window — local
   * midnight today — not a proposal. Committing a hands_off user to it minted a
   * confirmed 00:00 block that was already hours in the past, and accept's
   * claim consumed the candidate so the idea could never be re-offered.
   */
  it('never starts the block on the flex-window edge, which is local midnight', async () => {
    const candidate = openCandidate();
    await setup([candidate], HANDS_OFF_PROFILE);

    await service.sync(ctx);

    const [start] = acceptedStarts();
    expect(start).not.toEqual(candidate.windowStart);
    expect(start.getTime()).toBeGreaterThan(AFTERNOON.getTime());
  });

  it('honours a window that has not opened yet rather than booking before it', async () => {
    await setup([openCandidate({ windowStart: new Date('2026-08-23T00:00:00.000Z') })], HANDS_OFF_PROFILE);

    await service.sync(ctx);

    // Midnight is outside the waking band, so the block is offered at 10:00 on
    // the first day the window actually allows.
    expect(acceptedStarts()[0]).toEqual(new Date('2026-08-23T10:00:00.000Z'));
  });

  it('offers 10:00 instead of the small hours when the sync runs overnight', async () => {
    jest.setSystemTime(new Date('2026-08-20T03:00:00.000Z'));
    await setup([openCandidate()], HANDS_OFF_PROFILE);

    await service.sync(ctx);

    // sync() also runs off a queue job, so 03:05 is a reachable start.
    expect(acceptedStarts()[0]).toEqual(new Date('2026-08-20T10:00:00.000Z'));
  });

  it('rolls on to the next day once the waking band has closed', async () => {
    jest.setSystemTime(new Date('2026-08-20T22:00:00.000Z'));
    await setup([openCandidate()], HANDS_OFF_PROFILE);

    await service.sync(ctx);

    expect(acceptedStarts()[0]).toEqual(new Date('2026-08-21T10:00:00.000Z'));
  });

  it('queues successive auto-accepts instead of stacking them on one instant', async () => {
    await setup(
      [openCandidate({ id: 'cand-1' }), openCandidate({ id: 'cand-2', confidence: 0.9 })],
      HANDS_OFF_PROFILE,
    );

    await service.sync(ctx);

    // The second starts where the first's 30 minutes end.
    expect(acceptedStarts()).toEqual([SOON, new Date('2026-08-20T15:05:00.000Z')]);
  });

  it('does nothing when the profile has autoSchedule off (the projection-test default)', async () => {
    await setup([openCandidate()], BALANCED_PROFILE);

    await service.sync(ctx);

    expect(candidateService.accept).not.toHaveBeenCalled();
  });

  it('does not auto-accept a low-confidence candidate even for a hands_off user', async () => {
    await setup([openCandidate({ confidence: 0.3 })], HANDS_OFF_PROFILE);

    await service.sync(ctx);

    expect(candidateService.accept).not.toHaveBeenCalled();
  });

  it('skips a candidate with no duration estimate without accepting it', async () => {
    await setup([openCandidate({ durationMinutes: null })], HANDS_OFF_PROFILE);

    await service.sync(ctx);

    expect(candidateService.accept).not.toHaveBeenCalled();
  });

  it('still places a candidate that carries no window at all', async () => {
    await setup([openCandidate({ windowStart: null })], HANDS_OFF_PROFILE);

    await service.sync(ctx);

    expect(acceptedStarts()[0]).toEqual(SOON);
  });

  it('swallows a candidateService.accept failure and still processes the remaining candidates', async () => {
    await setup(
      [openCandidate({ id: 'cand-1', confidence: 0.95 }), openCandidate({ id: 'cand-2', confidence: 0.9 })],
      HANDS_OFF_PROFILE,
    );
    candidateService.accept.mockRejectedValueOnce(new Error('concurrent accept')).mockResolvedValueOnce({});

    await expect(service.sync(ctx)).resolves.not.toThrow();

    expect(candidateService.accept).toHaveBeenCalledTimes(2);
    // The failed accept committed no time, so it does not push the next one out.
    expect(acceptedStarts()).toEqual([SOON, SOON]);
  });

  it('queries only open candidates, newest-confidence-first, capped at 3', async () => {
    await setup([], HANDS_OFF_PROFILE);

    await service.sync(ctx);

    // Call order on the candidate repository: suppressRetiredIdeas, then
    // retireStale, then the auto-accept query.
    const autoAcceptQuery = candidates.find.mock.calls[2]?.[0];
    expect(autoAcceptQuery).toMatchObject({
      where: { userId: 'user-1', status: 'open' },
      order: { confidence: 'DESC' },
      take: 3,
    });
  });
});
