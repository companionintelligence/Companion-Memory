import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { DeadLettersCard, describeReplay, formatAge } from './DeadLettersCard';
import {
  DEAD_LETTER_PAGE,
  groupDeadLetters,
  type DeadLetter,
  type DeadLetterReplayResponse,
} from './useDeadLetters';

/**
 * The dead-letter card.
 *
 * Two properties decide whether this card is an improvement or a foot-gun:
 *
 *  1. **Replay sends the ids of the causes the operator SELECTED.** Every other
 *     shape — "all visible", "all in the table" — re-emits config errors that
 *     will fail identically and write a fresh letter each, which is how a
 *     94-row backlog becomes a 188-row backlog.
 *  2. **A failed replay is visible.** The single most likely outcome of
 *     replaying the biggest group on the appliance this was built against is
 *     that it fails the same way, because the cause is `LLM_DEFAULT_CHAT_MODEL`.
 *     A card that reports "done" there would train operators to keep pressing.
 */

function letter(overrides: Partial<DeadLetter> = {}): DeadLetter {
  return {
    id: 'letter-1',
    queue: 'dead-letter',
    eventName: 'infer.question.answer',
    stage: null,
    entityType: null,
    entityId: null,
    userId: null,
    payload: {},
    error: 'Invalid model specified: qwen/qwen3-vl-30b\n    at OllamaService.validateModel',
    failedAt: '2026-08-18T14:49:12.525Z',
    replayedAt: null,
    ...overrides,
  };
}

const OK: DeadLetterReplayResponse = {
  requested: 2,
  claimed: 2,
  limit: 50,
  replayed: [
    { id: 'a', jobIds: ['job-1'] },
    { id: 'b', jobIds: ['job-2'] },
  ],
  failed: [],
  skipped: [],
};

function renderCard(letters: DeadLetter[], onReplay = vi.fn(async () => OK)) {
  const groups = groupDeadLetters(letters);

  renderWithProviders(
    <DeadLettersCard
      groups={groups}
      total={letters.length}
      loading={false}
      error={null}
      onReplay={onReplay}
    />,
  );

  return { groups, onReplay };
}

describe('DeadLettersCard', () => {
  it('lists a cause with its event, count and age rather than one row per letter', () => {
    renderCard([
      letter({ id: 'a' }),
      letter({ id: 'b' }),
      letter({
        id: 'c',
        eventName: 'file.uploaded',
        error: 'Input buffer contains unsupported image format',
      }),
    ]);

    expect(screen.getByText('Invalid model specified: qwen/qwen3-vl-30b')).toBeInTheDocument();
    expect(screen.getByText('Input buffer contains unsupported image format')).toBeInTheDocument();
    expect(screen.getByText('infer.question.answer')).toBeInTheDocument();
    // Two letters collapsed into one row with a count of 2.
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText(/3 un-replayed across 2 causes/)).toBeInTheDocument();
  });

  it('replays exactly the ids of the selected cause, and nothing else', async () => {
    const onReplay = vi.fn(async () => OK);

    renderCard(
      [
        letter({ id: 'a' }),
        letter({ id: 'b' }),
        letter({ id: 'c', eventName: 'file.uploaded', error: 'unsupported image format' }),
      ],
      onReplay,
    );

    fireEvent.click(screen.getByLabelText(/Invalid model specified/));
    fireEvent.click(screen.getByRole('button', { name: /Replay selected \(2\)/ }));

    await waitFor(() => expect(onReplay).toHaveBeenCalledTimes(1));
    expect(onReplay).toHaveBeenCalledWith(['a', 'b']);
  });

  it('offers no replay at all until a cause is picked', () => {
    // There is deliberately no "select all": the endpoint refuses an empty
    // selector, and the UI must not invent a way around that.
    renderCard([letter({ id: 'a' })]);

    expect(screen.getByRole('button', { name: /Replay selected \(0\)/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /select all/i })).not.toBeInTheDocument();
  });

  it('reports letters that failed AGAIN, with the reason', async () => {
    const onReplay = vi.fn(async () => ({
      ...OK,
      replayed: [{ id: 'a', jobIds: ['job-1'] }],
      failed: [
        {
          id: 'b',
          eventName: 'infer.question.answer',
          reason: 'Invalid model specified: qwen/qwen3-vl-30b',
        },
      ],
    }));

    renderCard([letter({ id: 'a' }), letter({ id: 'b' })], onReplay);

    fireEvent.click(screen.getByLabelText(/Invalid model specified/));
    fireEvent.click(screen.getByRole('button', { name: /Replay selected/ }));

    const status = await screen.findByRole('status');

    expect(status).toHaveTextContent('Re-emitted 1');
    expect(status).toHaveTextContent('1 failed again');
    expect(status).toHaveTextContent('Invalid model specified: qwen/qwen3-vl-30b');
  });

  it('says "already replayed" for a double submit instead of pretending it worked', async () => {
    const onReplay = vi.fn(async () => ({
      requested: 2,
      claimed: 0,
      limit: 50,
      replayed: [],
      failed: [],
      skipped: ['a', 'b'],
    }));

    renderCard([letter({ id: 'a' }), letter({ id: 'b' })], onReplay);

    fireEvent.click(screen.getByLabelText(/Invalid model specified/));
    fireEvent.click(screen.getByRole('button', { name: /Replay selected/ }));

    expect(await screen.findByRole('status')).toHaveTextContent('2 already replayed');
  });

  it('clears the selection after a replay, so the button cannot be pressed twice', async () => {
    const onReplay = vi.fn(async () => OK);

    renderCard([letter({ id: 'a' }), letter({ id: 'b' })], onReplay);

    fireEvent.click(screen.getByLabelText(/Invalid model specified/));
    fireEvent.click(screen.getByRole('button', { name: /Replay selected \(2\)/ }));

    await waitFor(() => expect(onReplay).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /Replay selected \(0\)/ })).toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: /Replay selected \(0\)/ }));

    expect(onReplay).toHaveBeenCalledTimes(1);
  });

  it('surfaces a rejected replay rather than swallowing it', async () => {
    const onReplay = vi.fn(async () => {
      throw new Error('403 forbidden');
    });

    renderCard([letter({ id: 'a' })], onReplay as never);

    fireEvent.click(screen.getByLabelText(/Invalid model specified/));
    fireEvent.click(screen.getByRole('button', { name: /Replay selected/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('403 forbidden');
  });

  it('expands a cause to the full stack, which is what says whether replay can work', () => {
    // A stack in `validateModel` means config: replaying it will fail identically.
    renderCard([letter({ id: 'a' })]);

    fireEvent.click(screen.getByRole('button', { name: /Invalid model specified/ }));

    expect(screen.getByText(/at OllamaService.validateModel/)).toBeInTheDocument();
  });

  it('says so plainly when nothing has been dead-lettered', () => {
    renderCard([]);

    expect(screen.getByText(/Nothing has been dead-lettered/)).toBeInTheDocument();
  });
});

describe('formatAge', () => {
  const now = new Date('2026-08-18T15:00:00.000Z').getTime();

  it.each([
    [new Date('2026-08-18T14:59:30.000Z').getTime(), '30s ago'],
    [new Date('2026-08-18T14:30:00.000Z').getTime(), '30m ago'],
    [new Date('2026-08-18T05:00:00.000Z').getTime(), '10h ago'],
    [new Date('2026-08-10T15:00:00.000Z').getTime(), '8d ago'],
  ])('renders %s as %s', (from, expected) => {
    expect(formatAge(from, now)).toBe(expected);
  });

  it('never renders a negative age from clock skew', () => {
    expect(formatAge(now + 60_000, now)).toBe('0s ago');
  });
});

describe('describeReplay', () => {
  it('leads with what actually went back on the bus', () => {
    expect(describeReplay(OK)).toBe('Re-emitted 2.');
  });
});

/**
 * `total` is the length of ONE page — the request asks for at most
 * `DEAD_LETTER_PAGE` — so on an appliance with thousands of dead letters the
 * card read exactly "200 un-replayed", which looks like a count and is really
 * the ceiling. Sitting under a Health card that says "8,535 jobs have given
 * up", that was two unexplained numbers for the same thing.
 */
describe('DeadLettersCard when the page is full', () => {
  it('says the count is a first page rather than a total', () => {
    renderCard(
      Array.from({ length: DEAD_LETTER_PAGE }, (_, i) =>
        letter({ id: `dl-${i}` }),
      ),
    );

    expect(screen.getByText(/First 200 un-replayed/)).toBeInTheDocument();
    expect(screen.getByText(/there are more/)).toBeInTheDocument();
  });

  it('reports a short page as the exact count it is', () => {
    renderCard([
      letter({ id: 'dl-1' }),
      letter({ id: 'dl-2' }),
    ]);

    expect(screen.getByText(/^2 un-replayed/)).toBeInTheDocument();
    expect(screen.queryByText(/there are more/)).not.toBeInTheDocument();
  });
});
