import { EventIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';

import { SearchResultRow } from './SearchResultRow';

export const EVENT_FRAGMENT = gql(`
  fragment SearchResultEventData on EventType {
    id
    title
    startTime
  }
`);

interface Props {
  event: FragmentType<typeof EVENT_FRAGMENT>;
}

export function EventResult({ event }: Props) {
  const data = useFragment(EVENT_FRAGMENT, event);
  const fmt = useDateTimeFormat();

  return (
    <SearchResultRow
      icon={<EventIcon />}
      title={data.title}
      meta={fmt.dateTime(data.startTime)}
      kind="Event"
    />
  );
}
