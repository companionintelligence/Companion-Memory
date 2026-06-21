import { ContentIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

export const CONTENT_FRAGMENT = gql(`
  fragment SearchResultContentData on ContentType {
    id
    title
  }
`);

interface Props {
  content: FragmentType<typeof CONTENT_FRAGMENT>;
}

export function ContentResult({ content }: Props) {
  const data = useFragment(CONTENT_FRAGMENT, content);

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <ContentIcon />
        <div className="font-medium">{data.title}</div>
      </div>
      <div className="text-muted-foreground">Content</div>
    </div>
  );
}
