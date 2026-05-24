import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { makeFragmentData } from '@/graphql';

import { EntityGrid } from '../EntityGrid';

import { AnswerGridItem, ANSWER_FRAGMENT } from './AnswerGridItem';

type StoryProps = ComponentProps<typeof AnswerGridItem> & {
  question: string;
  answer: string;
};

const meta: Meta<StoryProps> = {
  component: AnswerGridItem,

  parameters: {
    layout: 'centered',
  },

  argTypes: {
    question: {
      control: 'text',
    },

    answer: {
      control: 'text',
    },
  },
};

export default meta;

type Story = StoryObj<StoryProps>;

export const Default: Story = {
  args: {
    question: 'Sample question?',
    answer: 'Sample answer text for the question.',
    onClick: fn(),
  },

  render: (args) => {
    const answer = {
      __typename: 'AnswerType' as const,
      id: 'mock-id-1',
      answer: args.answer,
      question: {
        __typename: 'QuestionType' as const,
        id: 'mock-question-id-1',
        text: args.question,
      },
    };

    const maskedAnswer = makeFragmentData(answer, ANSWER_FRAGMENT);

    return (
      <EntityGrid>
        <AnswerGridItem answer={maskedAnswer} onClick={args.onClick} />
      </EntityGrid>
    );
  },
};
