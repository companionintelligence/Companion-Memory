import { type MouseEvent } from 'react';

import { ContentIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { SearchTable } from '../SearchTable';

export const CONTENT_FRAGMENT = gql(`
  fragment TableContentRowData on ContentType {
    id
    title
    text
  }
`);

interface Props {
  content: FragmentType<typeof CONTENT_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function ContentRow({ content, onClick }: Props) {
  const data = useFragment(CONTENT_FRAGMENT, content);

  return (
    <SearchTable.Row onClick={onClick}>
      <SearchTable.Cell className="align-middle w-0 px-2.5">
        <ContentIcon />
      </SearchTable.Cell>

      <SearchTable.Cell className="align-middle w-100">{data.title}</SearchTable.Cell>

      <SearchTable.Cell className="align-middle">{data.text}</SearchTable.Cell>
    </SearchTable.Row>
  );
}
