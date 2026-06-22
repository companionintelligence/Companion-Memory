import { type MouseEvent, type ReactNode } from 'react';

import { AnswerIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityRow } from './EntityRow';

export const ANSWER_FRAGMENT = gql(`
  fragment TableAnswerRowData on AnswerType {
    id
    answer
    question {
      id
      text
    }
  }
`);

interface Props {
  answer: FragmentType<typeof ANSWER_FRAGMENT>;
  time?: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function AnswerRow({ answer, time, onClick }: Props) {
  const data = useFragment(ANSWER_FRAGMENT, answer);

  return (
    <EntityRow
      icon={<AnswerIcon />}
      title={data.question.text}
      subtitle={data.answer}
      time={time}
      onClick={onClick}
    />
  );
}
