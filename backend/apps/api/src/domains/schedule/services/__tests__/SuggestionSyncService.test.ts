import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { ActionEntity } from '@ci/domains/intelligence';
import { flexWindow, PersonalizationService, PlacementService } from '@ci/domains/personalization';
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

  async function setup(actionRows: ActionEntity[] = [], summaryRows: SummaryEntity[] = []) {
    actions = { find: jest.fn(async () => actionRows) };
    summaries = { find: jest.fn(async () => summaryRows) };
    candidates = { find: jest.fn(async () => []), save: jest.fn(async (e) => e) };
    candidateService = { upsert: jest.fn(async (_c, proposals) => proposals) };
    // autoSchedule off keeps the auto-accept leg out of these projection tests.
    personalization = { getProfile: jest.fn(async () => ({ autoSchedule: false })) };

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
});
