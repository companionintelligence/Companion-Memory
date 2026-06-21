import { type MouseEvent, useMemo } from 'react';

import { ContentIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityGridItem } from './EntityGridItem';

export const CONTENT_FRAGMENT = gql(`
  fragment ContentGridItemData on ContentType {
    id
    title
    text
    contentUrl: url
    sourceUrl
    mimetype
  }
`);

interface Props {
  content: FragmentType<typeof CONTENT_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

// External URLs are used directly; relative paths are served from the object
// store under /static.
function resolveMediaUrl(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  return /^https?:\/\//.test(value) ? value : `/static${value}`;
}

export function ContentGridItem({ content, onClick }: Props) {
  const data = useFragment(CONTENT_FRAGMENT, content);

  const imageUrl = useMemo(() => {
    const isImage = data.mimetype?.startsWith('image/');

    return isImage ? resolveMediaUrl(data.contentUrl ?? data.sourceUrl) : undefined;
  }, [data.mimetype, data.contentUrl, data.sourceUrl]);

  if (imageUrl) {
    return (
      <EntityGridItem className="relative p-0" onClick={onClick}>
        <div className="rounded-md overflow-hidden min-h-0 grow inset-0">
          <img src={imageUrl} alt={data.title || ''} className="w-full h-full object-cover" />
          {data.title && (
            <div className="absolute bottom-0 w-full truncate bg-gradient-to-t from-black/70 to-transparent p-2 px-3 text-sm text-white">
              {data.title}
            </div>
          )}
        </div>
      </EntityGridItem>
    );
  }

  return (
    <EntityGridItem onClick={onClick}>
      <EntityGridItem.Header>
        <ContentIcon className="shrink-0" />

        <div className="text-md font-semibold truncate">{data.title}</div>
      </EntityGridItem.Header>

      <EntityGridItem.Content>
        <div className="line-clamp-3 leading-tight">{data.text}</div>
      </EntityGridItem.Content>

      <EntityGridItem.Footer className="self-end">
        <div className="text-sm text-muted-foreground">Content</div>
      </EntityGridItem.Footer>
    </EntityGridItem>
  );
}
