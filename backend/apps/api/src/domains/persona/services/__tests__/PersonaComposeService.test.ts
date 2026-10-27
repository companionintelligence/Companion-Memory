import { fenceUntrusted } from '@ci/common/prompt/untrustedBlock';

import { PersonaComposeService } from '../PersonaComposeService';
import type { PersonaContextPackService } from '../PersonaContextPackService';

describe('PersonaComposeService', () => {
  function makeService(pack: {
    markdown: string;
    evidence: Array<{ kind: 'dossier' | 'preference'; note: string }>;
    hasSignal: boolean;
  }) {
    const chat = jest.fn();
    const upsert = jest.fn(async (_ctx: unknown, proposals: unknown[]) => proposals);
    const savePersonalization = jest.fn(async () => ({}));
    const contextPackService = {
      assemble: jest.fn(async () => pack),
    } as unknown as PersonaContextPackService;

    const service = new PersonaComposeService(
      contextPackService,
      { chat } as never,
      { upsert, savePersonalization } as never,
      { setContext: jest.fn(), warn: jest.fn() } as never,
    );

    return { service, chat, upsert, contextPackService };
  }

  const context = { userId: 'user-1' } as never;

  it('returns follow-up questions instead of inventing an approach when signal is thin', async () => {
    const { service, chat } = makeService({
      markdown: '# User Context\n\nNo graph profile.',
      evidence: [],
      hasSignal: false,
    });

    chat.mockResolvedValueOnce({
      message: {
        content: JSON.stringify({
          title: 'Plan a dinner',
          goal: 'Host friends',
          openQuestions: ['Who is invited?'],
          constraints: [],
        }),
      },
    });

    const result = await service.howYoudDoIt(context, 'plan a dinner for friends');

    expect(result.hasSignal).toBe(false);
    expect(result.approach).toEqual([]);
    expect(result.followUps.length).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(0.3);
    // Who + how calls are skipped when there is no signal after normalize.
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('runs the three-step chain and returns a grounded approach when signal exists', async () => {
    const { service, chat } = makeService({
      markdown: '# User Context\n\n## User Dossier Snapshot\n- Summary: Prefers calm evenings',
      evidence: [{ kind: 'dossier', note: 'from your dossier' }],
      hasSignal: true,
    });

    chat
      .mockResolvedValueOnce({
        message: {
          content: JSON.stringify({
            title: 'Make dinner',
            goal: 'A calm meal',
            openQuestions: [],
            constraints: ['weeknight'],
          }),
        },
      })
      .mockResolvedValueOnce({
        message: {
          content: JSON.stringify({
            personaBrief: 'You prefer calm evenings and low-stress hosting.',
            evidenceNotes: ['from your dossier'],
          }),
        },
      })
      .mockResolvedValueOnce({
        message: {
          content: JSON.stringify({
            approach: [
              { title: 'Pick a simple menu', detail: 'Something you already know', durationMinutes: 20 },
              { title: 'Invite two close friends', durationMinutes: 10 },
            ],
            timing: 'Early evening',
            people: [],
            followUps: [],
            confidence: 0.72,
          }),
        },
      });

    const result = await service.howYoudDoIt(context, 'make dinner for friends', { includeRecall: false });

    expect(result.hasSignal).toBe(true);
    expect(result.task.title).toBe('Make dinner');
    expect(result.personaBrief).toContain('calm evenings');
    expect(result.approach).toHaveLength(2);
    expect(result.evidence[0]?.kind).toBe('dossier');
    expect(chat).toHaveBeenCalledTimes(3);
  });

  it('drops the prompt escape from the dossier summary when the brief falls back to it', async () => {
    const { service, chat } = makeService({
      markdown: `## User Dossier Snapshot\n- Summary: ${fenceUntrusted('**Personality:** Curious.')}`,
      evidence: [{ kind: 'dossier', note: 'from your dossier' }],
      hasSignal: true,
    });

    chat
      .mockResolvedValueOnce({
        message: { content: JSON.stringify({ title: 'Plan', openQuestions: [], constraints: [] }) },
      })
      // The who-synthesis reply fails its schema, so the brief comes from the summary.
      .mockResolvedValueOnce({ message: { content: '{}' } })
      .mockResolvedValueOnce({
        message: { content: JSON.stringify({ approach: [], people: [], followUps: [], confidence: 0.4 }) },
      });

    const result = await service.howYoudDoIt(context, 'plan a week', { includeRecall: false });

    expect(result.personaBrief).toBe('You tend to operate like this: **Personality:** Curious.');
  });

  it('applyToPossibilities upserts one candidate per approach step', async () => {
    const { service, upsert } = makeService({
      markdown: '',
      evidence: [],
      hasSignal: true,
    });

    const added = await service.applyToPossibilities(context, {
      task: { title: 'Make dinner', openQuestions: [], constraints: [] },
      personaBrief: 'You prefer calm evenings.',
      approach: [
        { title: 'Pick a menu', durationMinutes: 20 },
        { title: 'Shop ingredients', durationMinutes: 40 },
      ],
      people: [],
      evidence: [{ kind: 'dossier', note: 'from your dossier' }],
      followUps: [],
      confidence: 0.7,
      hasSignal: true,
    });

    expect(added).toEqual({ added: 2 });
    expect(upsert).toHaveBeenCalledTimes(1);
    const proposals = upsert.mock.calls[0][1] as Array<{ title: string; generator: string }>;
    expect(proposals.map((p) => p.title)).toEqual(['Pick a menu', 'Shop ingredients']);
    expect(proposals[0].generator).toContain('braindump/persona');
  });
});
