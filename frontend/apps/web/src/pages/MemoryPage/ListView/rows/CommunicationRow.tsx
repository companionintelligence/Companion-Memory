import { type MouseEvent, type ReactNode } from 'react';

import { CommunicationIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityRow } from './EntityRow';

export const COMMUNICATION_FRAGMENT = gql(`
  fragment TableCommunicationRowData on CommunicationType {
    id
    subject
    preview
  }
`);

interface Props {
  communication: FragmentType<typeof COMMUNICATION_FRAGMENT>;
  time?: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function CommunicationRow({ communication, time, onClick }: Props) {
  const data = useFragment(COMMUNICATION_FRAGMENT, communication);

  return (
    <EntityRow
      icon={<CommunicationIcon />}
      title={data.subject || 'Untitled communication'}
      subtitle={data.preview}
      time={time}
      onClick={onClick}
    />
  );
}
