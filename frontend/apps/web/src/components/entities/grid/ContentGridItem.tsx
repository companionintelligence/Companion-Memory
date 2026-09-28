import { type MouseEvent, useMemo } from 'react';

import { ContentIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';
import { RICH_MEDIA_FRAGMENT } from '@/pages/MemoryPage/Components/EntityDetails/RichMediaCard';

import { EntityGridItem } from './EntityGridItem';

export const CONTENT_FRAGMENT = gql(`
  fragment ContentGridItemData on ContentType {
    id
    title
    text
    contentUrl: url
    sourceUrl
    sourceType
    sourceSystem
    sourceId
    createdAt
    mimetype
    mediaUrl
    playbackUrl
    playbackContentType
    mediaFilename
    mediaSize
    previewUrl
    ...RichMediaData
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
  const richMedia = useFragment(RICH_MEDIA_FRAGMENT, data);

  const imageUrl = useMemo(() => {
    const isImage = data.mimetype?.startsWith('image/');

    if (isImage) {
      return resolveMediaUrl(data.contentUrl ?? data.sourceUrl);
    }

    // No linked image: fall back to the resolved link preview — the
    // `enrich.unfurl` stage's cached poster (Spotify album art, an
    // OpenGraph image), then a tier-0 embed's own templated poster
    // (YouTube's thumbnail; Spotify has none).
    const unfurlThumbnail = richMedia.unfurl?.status === 'ok' ? richMedia.unfurl.thumbnailUrl : null;

    return resolveMediaUrl(unfurlThumbnail) ?? resolveMediaUrl(richMedia.player?.posterUrl) ?? undefined;
  }, [data.mimetype, data.contentUrl, data.sourceUrl, richMedia]);

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
