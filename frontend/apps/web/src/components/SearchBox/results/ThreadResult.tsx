import { ThreadIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

export const THREAD_FRAGMENT = gql(`
  fragment SearchResultThreadData on ThreadType {
    id
    name
    description
  }
`);

interface Props {
  thread: FragmentType<typeof THREAD_FRAGMENT>;
}

export function ThreadResult({ thread }: Props) {
  const data = useFragment(THREAD_FRAGMENT, thread);

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <ThreadIcon />
        <div className="font-medium truncate">{data.name}</div>
      </div>
      <div className="text-muted-foreground">Thread</div>
    </div>
  );
}
