import { type MouseEvent } from 'react';

import { EventIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { SearchTable } from '../SearchTable';

export const EVENT_FRAGMENT = gql(`
  fragment TableEventRowData on EventType {
    id
    title
    description
  }
`);

interface Props {
  event: FragmentType<typeof EVENT_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function EventRow({ event, onClick }: Props) {
  const data = useFragment(EVENT_FRAGMENT, event);

  return (
    <SearchTable.Row onClick={onClick}>
      <SearchTable.Cell className="align-middle w-0 px-2.5">
        <EventIcon />
      </SearchTable.Cell>

      <SearchTable.Cell className="align-middle w-100">{data.title}</SearchTable.Cell>

      <SearchTable.Cell className="align-middle">{data.description}</SearchTable.Cell>
    </SearchTable.Row>
  );
}
