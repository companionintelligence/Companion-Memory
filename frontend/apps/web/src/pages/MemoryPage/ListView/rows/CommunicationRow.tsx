import { type MouseEvent } from 'react';

import { CommunicationIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { SearchTable } from '../SearchTable';

export const COMMUNICATION_FRAGMENT = gql(`
  fragment TableCommunicationRowData on CommunicationType {
    id
    subject
    preview
  }
`);

interface Props {
  communication: FragmentType<typeof COMMUNICATION_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function CommunicationRow({ communication, onClick }: Props) {
  const data = useFragment(COMMUNICATION_FRAGMENT, communication);

  return (
    <SearchTable.Row onClick={onClick}>
      <SearchTable.Cell className="align-middle w-0 px-2.5">
        <CommunicationIcon />
      </SearchTable.Cell>

      <SearchTable.Cell className="align-middle w-100">{data.subject}</SearchTable.Cell>

      <SearchTable.Cell className="align-middle">{data.preview}</SearchTable.Cell>
    </SearchTable.Row>
  );
}
