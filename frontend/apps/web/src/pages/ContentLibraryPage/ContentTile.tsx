import { type ComponentType, useMemo } from 'react';

import { Tooltip } from '@ci/shadcn';
import { FileText, Globe, Image as ImageIcon, Music, Video } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

import { ChatAbout } from '@/components/ChatWithAgent';
import { resolveContentTileUrl } from '@/components/entities/resolveMediaUrl';
import { ContentIcon } from '@/components/icons';
import { gql, type FragmentType, useFragment } from '@/graphql';
import { namedChatContext } from '@/lib/agentChat';
import { RICH_MEDIA_FRAGMENT } from '@/pages/MemoryPage/Components/EntityDetails/RichMediaCard';

export const ContentTileFragment = gql(`
  fragment ContentTileFragment on ContentType {
    id
    title
    text
    mimetype
    contentUrl: url
    sourceUrl
    previewUrl
    mediaUrl
    ...RichMediaData
  }
`);

/** Glyph for a row with no picture, chosen from the mimetype's top-level type. */
type KindIcon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

export function contentKindFor(mimetype?: string | null): { Icon: KindIcon; label: string } {
  const type = (mimetype ?? '').toLowerCase();

  if (type.startsWith('image/')) {
    return { Icon: ImageIcon, label: 'Image' };
  }

  if (type.startsWith('video/')) {
    return { Icon: Video, label: 'Video' };
  }

  if (type.startsWith('audio/')) {
    return { Icon: Music, label: 'Audio' };
  }

  if (type === 'text/html' || type === 'application/xhtml+xml') {
    return { Icon: Globe, label: 'Web page' };
  }

  if (type === 'application/pdf') {
    return { Icon: FileText, label: 'PDF' };
  }

  if (type.startsWith('text/') || type.startsWith('application/')) {
    return { Icon: FileText, label: 'Document' };
  }

  return { Icon: ContentIcon, label: 'Content' };
}

export function ContentTile({
  content: contentMasked,
  onSelect,
}: {
  content: FragmentType<typeof ContentTileFragment>;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const content = useFragment(ContentTileFragment, contentMasked);
  const richMedia = useFragment(RICH_MEDIA_FRAGMENT, content);

  // Title and text are user data and go in verbatim; only the fallback is copy.
  const name = content.title?.trim() || t('CONTENT_UNTITLED');
  const imageUrl = useMemo(
    () =>
      resolveContentTileUrl({
        ...content,
        unfurlThumbnailUrl: richMedia.unfurl?.status === 'ok' ? richMedia.unfurl.thumbnailUrl : null,
        playerPosterUrl: richMedia.player?.posterUrl,
      }),
    [content, richMedia],
  );
  const { Icon, label } = contentKindFor(content.mimetype);

  return (
    <ChatAbout
      context={namedChatContext({
        title: name,
        body: content.text,
        sourceKind: 'ContentType',
        sourceId: content.id,
      })}
    >
      <Tooltip delayDuration={600}>
        <Tooltip.Content>{name}</Tooltip.Content>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            onClick={() => onSelect(content.id)}
            className="relative group aspect-square rounded-lg overflow-hidden border border-border bg-muted transition-transform hover:shadow-md w-full cursor-pointer text-left"
            aria-label={name}
          >
            {imageUrl ? (
              <>
                <img
                  src={imageUrl}
                  alt={content.title || ''}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
                {content.title && (
                  <div className="absolute bottom-0 w-full truncate bg-gradient-to-t from-black/70 to-transparent p-2 px-3 text-sm text-white">
                    {content.title}
                  </div>
                )}
              </>
            ) : (
              <div className="flex h-full w-full flex-col gap-2 p-3">
                <div className="flex items-center gap-2 min-w-0">
                  <Icon className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="truncate text-sm font-medium">{name}</div>
                </div>

                {content.text ? (
                  <p className="line-clamp-5 text-xs leading-snug text-muted-foreground break-words">
                    {content.text}
                  </p>
                ) : (
                  <div className="flex grow items-center justify-center">
                    <Icon className="h-10 w-10 text-muted-foreground/60" aria-hidden />
                  </div>
                )}

                <div className="mt-auto truncate text-[11px] uppercase tracking-wide text-muted-foreground/80">
                  {label}
                  {content.mimetype ? ` · ${content.mimetype}` : ''}
                </div>
              </div>
            )}
          </button>
        </Tooltip.Trigger>
      </Tooltip>
    </ChatAbout>
  );
}
