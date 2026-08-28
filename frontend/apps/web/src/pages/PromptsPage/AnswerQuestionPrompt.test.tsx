import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AnswerQuestionPrompt } from './AnswerQuestionPrompt';

vi.mock('@/hooks', () => ({ useAuth: () => [{ authToken: 'test-token' }] }));

function jsonResponse(body: unknown, status = 200) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * `findOneUnanswered` deterministically hands back the front of the queue
 * every time. "Skip" used to only set local `dismissed` state and unmount the
 * card — nothing told the server, so the identical question was back on the
 * next reload. It now calls `POST /questions/unanswered/skip` (moving the row
 * to the back) before refetching, so the follow-up GET can return something
 * different.
 */
describe('AnswerQuestionPrompt — Skip', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('tells the server to skip the current presentation, then asks for another', async () => {
    const calls: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? 'GET'} ${url}`);

        if (url.endsWith('/questions/unanswered/skip')) {
          expect(JSON.parse(String(init?.body))).toEqual({ presentationId: 'fq-1' });

          return Promise.resolve(jsonResponse(null, 204));
        }

        // First GET returns the question with its presentationId; the GET
        // that follows the skip returns a different one, proving the round
        // trip actually changed something rather than looping on the same row.
        const alreadySkipped = calls.filter((c) => c.includes('/skip')).length > 0;

        return Promise.resolve(
          jsonResponse(
            alreadySkipped
              ? { id: 'q2', text: 'A different question', presentationId: 'fq-2' }
              : { id: 'q1', text: 'The first question', presentationId: 'fq-1' },
          ),
        );
      }),
    );

    render(<AnswerQuestionPrompt />);

    expect(await screen.findByText('The first question')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /skip/i }));

    await waitFor(() => expect(screen.getByText('A different question')).toBeInTheDocument());
    expect(calls.some((c) => c.startsWith('POST') && c.includes('/questions/unanswered/skip'))).toBe(true);
  });
});
