import { CommunicationIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';

import { SearchResultRow } from './SearchResultRow';

export const COMMUNICATION_FRAGMENT = gql(`
  fragment SearchResultCommunicationData on CommunicationType {
    id
    preview
    time
  }
`);

interface Props {
  communication: FragmentType<typeof COMMUNICATION_FRAGMENT>;
}

export function CommunicationResult({ communication }: Props) {
  const data = useFragment(COMMUNICATION_FRAGMENT, communication);
  const fmt = useDateTimeFormat();

  return (
    <SearchResultRow
      icon={<CommunicationIcon />}
      title={data.preview}
      meta={fmt.dateTime(data.time)}
      kind="Communication"
    />
  );
}
