import { useMutation } from '@apollo/client';

import { CONTENT_FRAGMENT } from '@/components/entities/grid/ContentGridItem';
import { formatEntityLabel, formatEntityTimestamp } from '@/components/EntityFields';
import { gql, useFragment } from '@/graphql';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';

import type { MemoryEntityOf } from '../../useEntityService';

import { DocumentFileActions, formatBytes, isHttpUrl } from './DocumentFileActions';
import { EntityDetailScaffold, EntityMedia, resolveStaticUrl } from './EntityDetailScaffold';
import { hasRichMedia, RichMediaCard } from './RichMediaCard';

const UPDATE_CONTENT = gql(`
  mutation UpdateContentDetail($input: UpdateContentInput!) {
    updateContent(input: $input) {
      id
      title
      text
    }
  }
`);

interface Props {
  entity: MemoryEntityOf<'ContentType'>;
}

function originHref(...candidates: Array<string | null | undefined>): string | undefined {
  return candidates.find((value): value is string => isHttpUrl(value));
}

export function ContentDetails({ entity }: Props) {
  const data = useFragment(CONTENT_FRAGMENT, entity);
  const [updateContent] = useMutation(UPDATE_CONTENT);
  const fmt = useDateTimeFormat();

  // The ORIGINAL renders (mediaUrl — the linked file's full-resolution
  // variant), with the PREVIEW painted while it downloads, same as the event
  // pane. Rows without a linked file (bookmarks, articles) fall back to the
  // row's own url/sourceUrl exactly as before.
  //
  // Video too, not only image: EntityMedia already renders a <video> for a
  // video/* mimetype, but this gate never let one through, so a stored video
  // (a Facebook upload, say) showed nothing at all in the drawer. A REMOTE
  // video src still ends in EntityMedia's "couldn't be loaded" state — the
  // gateway's CSP is media-src 'self' — which is the honest outcome, and the
  // "Open original" link it offers is the only thing that can work for one.
  const isMedia = /^(image|video)\//.test(data.mimetype ?? '');
  const isVideo = data.mimetype?.startsWith('video/') ?? false;
  // A video plays from the server's browser-playable rendition when one exists
  // (the H.264 PLAYBACK variant, for HEVC and the like); the original stays the
  // "open or save" target.
  const playbackSrc = isVideo ? resolveStaticUrl(data.playbackUrl) : null;
  const mediaSrc = isMedia
    ? (playbackSrc ?? resolveStaticUrl(data.mediaUrl ?? data.contentUrl ?? data.sourceUrl))
    : undefined;
  const mediaContentType = playbackSrc ? (data.playbackContentType ?? data.mimetype) : data.mimetype;
  const mediaPreviewSrc = isMedia ? resolveStaticUrl(data.previewUrl) : undefined;
  const fileHref = resolveStaticUrl(data.mediaUrl);
  const sourceHref = originHref(data.sourceUrl, data.contentUrl);
  const showFileOpen = Boolean(fileHref) && !isMedia;

  return (
    <EntityDetailScaffold
      entity={entity}
      title={data.title || data.mediaFilename || 'Content'}
      subtitle="Content"
      taggable
      media={
        // A link with a resolved preview or a provider player shows THAT — the
        // poster, the facts, click-to-play — instead of a file glyph.
        hasRichMedia(data) ? (
          <RichMediaCard content={data} title={data.title} url={data.contentUrl ?? data.sourceUrl} />
        ) : (
          <EntityMedia
            src={mediaSrc}
            previewSrc={mediaPreviewSrc}
            contentType={mediaContentType}
            alt={data.title ?? ''}
            fallbackHref={(isVideo ? fileHref : null) ?? data.contentUrl ?? data.sourceUrl}
          />
        )
      }
      editFields={[
        { key: 'title', label: 'Title', value: data.title ?? '' },
        { key: 'text', label: 'Text', value: data.text ?? '', multiline: true, hideWhenEmpty: true },
      ]}
      onSave={async (values) => {
        await updateContent({
          variables: { input: { id: entity.id, title: values.title, text: values.text } },
        });
      }}
      metaItems={[
        { label: 'Filename', value: data.mediaFilename },
        { label: 'Type', value: data.mimetype },
        { label: 'Size', value: formatBytes(data.mediaSize) },
        { label: 'Source', value: formatEntityLabel(data.sourceSystem) },
        { label: 'Source type', value: formatEntityLabel(data.sourceType) },
        {
          label: 'Source URL',
          value: sourceHref ? (
            <a
              href={sourceHref}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-primary hover:underline"
            >
              {sourceHref}
            </a>
          ) : null,
        },
        {
          label: 'Created',
          value: data.createdAt ? formatEntityTimestamp(String(data.createdAt), fmt) : null,
        },
      ]}
      rawData={data}
    >
      {showFileOpen && fileHref && <DocumentFileActions href={fileHref} filename={data.mediaFilename} />}
      {!fileHref && sourceHref && <DocumentFileActions href={sourceHref} label="Open source" />}
    </EntityDetailScaffold>
  );
}
