import { ContentIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { SearchResultRow } from './SearchResultRow';

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

  return <SearchResultRow icon={<ContentIcon />} title={data.title} kind="Content" />;
}
