import { useMutation, useQuery } from '@apollo/client';
import { Link } from 'react-router-dom';

import { gql, useFragment } from '@/graphql';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';

import type { MemoryEntityOf } from '../../useEntityService';
import { COMMUNICATION_FRAGMENT } from '../EntityCard/CommunicationCard';

import { EntityDetailScaffold, EntityMedia, resolveStaticUrl } from './EntityDetailScaffold';
import { asHttpUrl } from './GenericDetails';

const UPDATE_COMMUNICATION = gql(`
  mutation UpdateCommunicationDetail($input: UpdateCommunicationInput!) {
    updateCommunication(input: $input) {
      id
      subject
      preview
      communicationContent: content
    }
  }
`);

/**
 * Fetched by the drawer alone, not folded into the shared card fragment:
 * every list and timeline reads that fragment for hundreds of rows at a time,
 * and `attachments` is a per-row resolver over the stored files. One message
 * open in the drawer is the only place the pictures are wanted at full size.
 */
export const GET_COMMUNICATION_ATTACHMENTS = gql(`
  query GetCommunicationAttachments($id: ID!) {
    node(id: $id) {
      __typename
      id
      ... on CommunicationType {
        metadata
        attachments {
          fileId
          contentId
          filename
          contentType
          url
          previewUrl
          width
          height
          size
        }
      }
    }
  }
`);

type Attachment = {
  fileId?: string | null;
  contentId?: string | null;
  filename?: string | null;
  contentType?: string | null;
  url?: string | null;
  previewUrl?: string | null;
};

function capitalize(value?: string | null): string {
  return value ? value[0].toUpperCase() + value.slice(1) : '';
}

function isRenderableMedia(attachment: Attachment): boolean {
  const contentType = attachment.contentType ?? '';

  return Boolean(attachment.url) && (contentType.startsWith('image/') || contentType.startsWith('video/'));
}

interface Props {
  entity: MemoryEntityOf<'CommunicationType'>;
}

export function CommunicationDetails({ entity }: Props) {
  const data = useFragment(COMMUNICATION_FRAGMENT, entity);
  const [updateCommunication] = useMutation(UPDATE_COMMUNICATION);
  const fmt = useDateTimeFormat();

  const { data: attachmentData } = useQuery(GET_COMMUNICATION_ATTACHMENTS, {
    variables: { id: entity.id },
    fetchPolicy: 'cache-first',
  });

  const attachmentNode = attachmentData?.node;
  const attachments: Attachment[] =
    attachmentNode?.__typename === 'CommunicationType' ? (attachmentNode.attachments ?? []) : [];

  // Two different URLs live in a post's metadata and they must not be
  // conflated. `permalink_url` is the POST on its source service; `link` is
  // what the post pointed AT — for a photo post that is one photo's own page,
  // for a share it is the shared article. Showing `link` under "Link" sent a
  // reader to a single photo instead of the post that carried three. Both
  // open in a new tab like every other off-appliance link in the drawer.
  const metadata =
    attachmentNode?.__typename === 'CommunicationType'
      ? ((attachmentNode.metadata ?? {}) as Record<string, unknown>)
      : {};
  const permalink = asHttpUrl(metadata.permalink_url) ?? asHttpUrl(metadata.url);
  const sharedLink = asHttpUrl(metadata.link);
  const externalLink = (href: string) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="break-all text-primary hover:underline"
    >
      {href}
    </a>
  );

  // The photos and videos that came with the message, at full size, above the
  // text — a Facebook post is mostly its picture; the words are the caption.
  // Same ORIGINAL-with-PREVIEW-underneath rendering the event and file
  // drawers use, so a stored video plays inline and a stored image paints its
  // 300px preview while the original downloads. Attachments that are not
  // pictures (a PDF on an email) are listed below by name instead.
  const media = attachments.filter(isRenderableMedia);
  // Every attachment is also listed by name under "Attachments": one that is
  // a content row in the memory links to that row in the Content library, one
  // that is only a stored or remote file opens the file itself. The in-drawer
  // jump to the file or content record is a Connections card, projected from
  // the attachments column by the graph's edge rules
  // (communication.has_attachment / has_content_attachment).
  const listed = attachments.filter(
    (attachment) => attachment.contentId || attachment.url || attachment.filename,
  );
  const attachmentName = (attachment: Attachment, index: number) =>
    attachment.filename ?? `Attachment ${index + 1}`;

  const headline = `${capitalize(data.direction)} ${capitalize(data.type)}`.trim();
  const recipients = (data.to?.edges ?? [])
    .map((edge) => edge.node.name)
    .filter((name): name is string => Boolean(name))
    .join(', ');

  // Chat-style sources have no subject: the preview becomes the title (its
  // only rendering) rather than showing a synthesized "Inbound Chat" headline;
  // the headline is a last resort for truly empty communications.
  return (
    <EntityDetailScaffold
      entity={entity}
      title={data.subject || data.preview || headline || 'Communication'}
      subtitle={data.subject ? data.preview : undefined}
      subtitleKind="text"
      media={
        media.length > 0 ? (
          <div className="flex flex-col gap-3" data-testid="communication-attachments">
            {media.map((attachment, index) => (
              <EntityMedia
                key={attachment.fileId ?? attachment.contentId ?? `${index}`}
                src={resolveStaticUrl(attachment.url)}
                previewSrc={
                  attachment.contentType?.startsWith('video/')
                    ? undefined
                    : resolveStaticUrl(attachment.previewUrl)
                }
                contentType={attachment.contentType}
                alt={attachment.filename ?? ''}
                fallbackHref={resolveStaticUrl(attachment.url)}
              />
            ))}
          </div>
        ) : undefined
      }
      taggable
      editFields={[
        { key: 'subject', label: 'Subject', value: data.subject ?? '' },
        { key: 'content', label: 'Content', value: data.communicationContent ?? '', multiline: true },
      ]}
      onSave={async (values) => {
        await updateCommunication({
          variables: { input: { id: entity.id, subject: values.subject, content: values.content } },
        });
      }}
      metaItems={[
        { label: 'Type', value: capitalize(data.type) },
        { label: 'Direction', value: capitalize(data.direction) },
        { label: 'When', value: data.time ? fmt.dateTime(data.time) : null },
        { label: 'From', value: data.from?.name },
        { label: 'To', value: recipients || null },
        { label: 'Link', value: permalink ? externalLink(permalink) : null },
        {
          label: 'Shared link',
          value: sharedLink && sharedLink !== permalink ? externalLink(sharedLink) : null,
        },
        {
          label: 'Attachments',
          value:
            listed.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {listed.map((attachment, index) => (
                  <li key={attachment.fileId ?? attachment.contentId ?? `${index}`} className="break-all">
                    {attachment.contentId ? (
                      <Link
                        to={`/memory/content/${attachment.contentId}`}
                        className="text-primary hover:underline"
                      >
                        {attachmentName(attachment, index)}
                      </Link>
                    ) : attachment.url ? (
                      <a
                        href={resolveStaticUrl(attachment.url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        {attachmentName(attachment, index)}
                      </a>
                    ) : (
                      <span>{attachmentName(attachment, index)}</span>
                    )}
                    {attachment.contentId && attachment.url ? (
                      <>
                        {' · '}
                        <a
                          href={resolveStaticUrl(attachment.url)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:underline"
                        >
                          original
                        </a>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null,
        },
      ]}
      rawData={data}
    />
  );
}
