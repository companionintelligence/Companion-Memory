import { type MouseEvent } from 'react';

import { AnswerIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { SearchTable } from '../SearchTable';

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
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function AnswerRow({ answer, onClick }: Props) {
  const data = useFragment(ANSWER_FRAGMENT, answer);

  return (
    <SearchTable.Row onClick={onClick}>
      <SearchTable.Cell className="align-middle w-0 px-2.5">
        <AnswerIcon />
      </SearchTable.Cell>

      <SearchTable.Cell className="align-middle w-100">{data.question.text}</SearchTable.Cell>

      <SearchTable.Cell className="align-middle">{data.answer}</SearchTable.Cell>
    </SearchTable.Row>
  );
}
