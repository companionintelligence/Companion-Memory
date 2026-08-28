import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { makeFragmentData } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { ANSWER_FRAGMENT, AnswerGridItem } from './AnswerGridItem';

const makeAnswer = (overrides: Record<string, unknown> = {}) =>
  makeFragmentData(
    {
      __typename: 'AnswerType' as const,
      id: 'a1',
      answer: 'Because it terminates at the base case.',
      question: { __typename: 'QuestionType' as const, id: 'q1', text: 'Why does recursion work?' },
      ...overrides,
    },
    ANSWER_FRAGMENT,
  );

describe('AnswerGridItem', () => {
  it('renders the question and answer text', () => {
    renderWithProviders(<AnswerGridItem answer={makeAnswer()} />);

    expect(screen.getByText('Why does recursion work?')).toBeInTheDocument();
    expect(screen.getByText('Because it terminates at the base case.')).toBeInTheDocument();
  });

  it('marks an inferred answer with the amber dot and its confidence band', () => {
    renderWithProviders(
      <AnswerGridItem
        answer={makeAnswer({
          answerSource: 'inferred',
          answerConfidence: 0.93,
          answerRationale: 'You said so in the coffee question.',
        })}
      />,
    );

    // Compact form: the bare band word is visible, the full wording is the
    // accessible name (see AnswerProvenance).
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText('Inferred, high confidence')).toHaveClass('sr-only');
  });

  it('marks a user-authored answer with the green dot', () => {
    renderWithProviders(<AnswerGridItem answer={makeAnswer({ answerSource: 'user_input' })} />);

    expect(screen.getByText('Answered by you')).toHaveClass('sr-only');
  });

  it('selects answerEvidence in the fragment, which is what makes the server send it', () => {
    // Asserted against the DOCUMENT, not against rendered output: `useFragment`
    // is a compile-time cast and `makeFragmentData` does not mask anything at
    // runtime, so a test that only renders a hand-built object passes happily
    // while the real query asks for a field the server was never told to send.
    // The selection set is the only place the fact actually lives.
    const [fragment] = ANSWER_FRAGMENT.definitions;
    const selected =
      fragment?.kind === 'FragmentDefinition'
        ? fragment.selectionSet.selections.flatMap((selection) =>
            selection.kind === 'Field' ? [selection.name.value] : [],
          )
        : [];

    expect(selected).toContain('answerEvidence');
  });

  it('carries evidence citations from the fragment into the provenance drawer', () => {
    // Given the field is selected (above), this is the rest of the path: the
    // tile hands the fragment data to the drawer whole, and the drawer reads
    // citations off it — so a grid tile shows the same evidence the Self page
    // does, instead of telling the reader no source records were kept for an
    // answer that has them.
    renderWithProviders(
      <AnswerGridItem
        answer={makeAnswer({
          answerSource: 'inferred',
          answerConfidence: 0.9,
          answerRationale: 'You said so in February.',
          answerEvidence: {
            citations: [
              {
                line: 2,
                type: 'communication',
                id: '01a02032-1653-77c9-894e-6ffa1416381c',
                at: '2015-02-20T00:16:32.069Z',
                voice: 'own',
                snippet: '[I wrote, Feb 19, 2015] "I sit on the board of an education charity."',
              },
            ],
            linesShown: 16,
            linesOwn: 12,
            model: 'gemma4:e4b',
          },
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Show where this answer came from/ }));

    expect(screen.getByTestId('answer-citation')).toBeInTheDocument();
    expect(
      screen.getByText('[I wrote, Feb 19, 2015] "I sit on the board of an education charity."'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No source records were kept/)).not.toBeInTheDocument();
  });

  it('fires onClick', () => {
    const onClick = vi.fn();
    renderWithProviders(<AnswerGridItem answer={makeAnswer()} onClick={onClick} />);

    fireEvent.click(screen.getByText('Why does recursion work?'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
