import { CommunicationIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

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

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <CommunicationIcon />
        <div className="font-medium truncate max-w-[25ch]">{data.preview}</div>
        <div className="text-muted-foreground">{new Date(data.time).toLocaleString()}</div>
      </div>
      <div className="text-muted-foreground">Communication</div>
    </div>
  );
}
