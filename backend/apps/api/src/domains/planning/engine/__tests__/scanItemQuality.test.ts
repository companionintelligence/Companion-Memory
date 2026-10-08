import { confidenceForScan, formatInboxMessage, inboxMessageIsEmpty, isEchoTitle } from '../scanItemQuality';
import { interpretClassify, interpretConsolidate } from '../scanTurn';

describe('scan item quality', () => {
  it('treats a missing confidence as a review-only score', () => {
    expect(confidenceForScan(undefined)).toBeLessThan(0.55);
    expect(confidenceForScan(0.9)).toBe(0.9);
  });

  it('rejects header, subject, and type-label titles', () => {
    expect(isEchoTitle('email 2026-09-24T23:04:29.000Z')).toBe(true);
    expect(isEchoTitle('chat 2026-10-04T21:35:25.493Z')).toBe(true);
    expect(isEchoTitle('Subject: New sign-in detected')).toBe(true);
    expect(isEchoTitle('chat: standup')).toBe(true);
    expect(isEchoTitle('Reply to Sam about lunch')).toBe(false);
  });

  it('does not lead the prompt with a pasteable type and timestamp', () => {
    const block = formatInboxMessage(
      {
        communicationType: 'email',
        time: new Date('2026-09-24T23:04:29.000Z'),
        subject: 'New sign-in detected on your Vercel account',
        preview: 'We noticed a sign-in.',
      },
      1,
    );

    expect(block.startsWith('[1]\nType: email')).toBe(true);
    expect(block.includes('email 2026-09-24T23:04:29.000Z')).toBe(false);
  });

  it('drops a message with no subject and no body', () => {
    expect(inboxMessageIsEmpty({ subject: '  ', preview: '', content: '' })).toBe(true);
    expect(inboxMessageIsEmpty({ subject: '', preview: 'No details provided' })).toBe(false);
  });
});

describe('scan turn interpretation', () => {
  it('accepts an explicit skip for every index', () => {
    const outcome = interpretClassify(
      JSON.stringify({ decisions: [{ sourceIndex: 1, action: 'skip' }] }),
      1,
      () => undefined,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.candidates).toEqual([]);
  });

  it('fails a batch that copies the message header or skips an index', () => {
    const echo = interpretClassify(
      JSON.stringify({
        decisions: [{ sourceIndex: 1, action: 'candidate', title: 'email 2026-09-24T23:04:29.000Z' }],
      }),
      1,
      () => 'email 2026-09-24T23:04:29.000Z',
    );
    const gap = interpretClassify(
      JSON.stringify({ decisions: [{ sourceIndex: 1, action: 'skip' }] }),
      2,
      () => undefined,
    );

    expect(echo.ok).toBe(false);
    expect(gap.ok).toBe(false);
  });

  it('drops a consolidated title that is still a header and keeps a real one', () => {
    const todos = interpretConsolidate(
      JSON.stringify({
        items: [
          { title: 'email 2026-09-24T23:04:29.000Z', sourceIndex: 1 },
          { title: 'Reply to Sam about lunch', sourceIndex: 2 },
        ],
      }),
      [
        { sourceIndex: 1, title: 'Review the sign-in', headerLine: 'email 2026-09-24T23:04:29.000Z' },
        { sourceIndex: 2, title: 'Reply to Sam about lunch' },
      ],
    );

    expect(todos).toEqual([expect.objectContaining({ title: 'Reply to Sam about lunch', sourceIndex: 2 })]);
  });
});
