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

  it('fires onClick', () => {
    const onClick = vi.fn();
    renderWithProviders(<AnswerGridItem answer={makeAnswer()} onClick={onClick} />);

    fireEvent.click(screen.getByText('Why does recursion work?'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
