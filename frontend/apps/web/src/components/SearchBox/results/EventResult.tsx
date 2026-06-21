import { EventIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

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

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <EventIcon />
        <div className="font-medium">{data.title}</div>
        <div className="text-muted-foreground">{new Date(data.startTime).toLocaleString()}</div>
      </div>
      <div className="text-muted-foreground">Event</div>
    </div>
  );
}
