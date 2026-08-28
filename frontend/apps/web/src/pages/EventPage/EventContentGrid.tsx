import { GlobalUID } from '@ci/common';
import { Card } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import { resolveContentTileUrl } from '@/components/entities/resolveMediaUrl';
import { ContentIcon } from '@/components/icons';
import { gql, type FragmentType, useFragment } from '@/graphql';
import { RICH_MEDIA_FRAGMENT } from '@/pages/MemoryPage/Components/EntityDetails/RichMediaCard';

export const EVENT_CONTENT_TILE = gql(`
  fragment EventContentTile on ContentType {
    id
    title
    mimetype
    contentUrl: url
    sourceUrl
    previewUrl
    mediaUrl
    ...RichMediaData
  }
`);

function Tile({ content: masked }: { content: FragmentType<typeof EVENT_CONTENT_TILE> }) {
  const content = useFragment(EVENT_CONTENT_TILE, masked);
  const richMedia = useFragment(RICH_MEDIA_FRAGMENT, content);
  const imageUrl = resolveContentTileUrl({
    ...content,
    unfurlThumbnailUrl: richMedia.unfurl?.status === 'ok' ? richMedia.unfurl.thumbnailUrl : null,
    playerPosterUrl: richMedia.player?.posterUrl,
  });
  const name = content.title?.trim() || 'Untitled';

  return (
    <Link
      to={`/content/${GlobalUID.parse('content', content.id)}`}
      title={name}
      aria-label={name}
      className="relative aspect-square overflow-hidden rounded-md border bg-muted transition-shadow hover:shadow-md"
    >
      {imageUrl ? (
        <img src={imageUrl} alt={content.title || ''} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-center">
          <ContentIcon className="h-8 w-8" />
          <div className="line-clamp-2 text-xs text-muted-foreground">{name}</div>
        </div>
      )}
    </Link>
  );
}

/**
 * The content rows linked to an event (`ci.content.event_id`) — the photos of
 * a photo event, the page of a visit, … Each tile shows the row's media when
 * it has any and opens its content page.
 */
export function EventContentGrid({ contents }: { contents: FragmentType<typeof EVENT_CONTENT_TILE>[] }) {
  if (contents.length === 0) {
    return null;
  }

  return (
    <Card>
      <Card.Header>
        <Card.Title>Related content</Card.Title>
      </Card.Header>
      <Card.Content>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {contents.map((content, index) => (
            <Tile key={index} content={content} />
          ))}
        </div>
      </Card.Content>
    </Card>
  );
}
