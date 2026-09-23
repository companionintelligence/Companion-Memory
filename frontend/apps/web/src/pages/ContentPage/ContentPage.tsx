import { type ReactNode, useState } from 'react';

import { useMutation, useQuery } from '@apollo/client';
import { GlobalUID, LoadingPage, usePageTitle, EmptyState } from '@ci/common';
import { useParams } from 'react-router-dom';

import { ChatWithAgentMenu } from '@/components/ChatWithAgent';
import { EntityEvolutionPanel } from '@/components/EntityEvolution/EntityEvolutionPanel';
import { EntityFieldsCard } from '@/components/EntityFields';
import { EntityGraph } from '@/components/EntityGraph';
import { EntityRelationshipCards } from '@/components/EntityRelationshipCards/EntityRelationshipCards';
import { EntityEditToggle, EntityTagsDescriptionCard } from '@/components/EntityTagsDescriptionCard';
import { ErrorState } from '@/components/ErrorState';
import { ContentIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';
import { gql } from '@/graphql';
import { namedChatContext } from '@/lib/agentChat';
import {
  EntityMedia,
  resolveStaticUrl,
} from '@/pages/MemoryPage/Components/EntityDetails/EntityDetailScaffold';
import { hasRichMedia, RichMediaCard } from '@/pages/MemoryPage/Components/EntityDetails/RichMediaCard';

// Exported for the colocated test, which mocks it failing.
export const GET_CONTENT = gql(`
  query GetContent($id: ID!) {
    content(id: $id) {
      id
      title
      text
      mimetype
      contentUrl: url
      sourceUrl
      # The local copy (external_id -> ci.files), resolved server-side. Preferred
      # over url/sourceUrl, which for imported photos is often the provider's
      # web page (e.g. photos.google.com/photo/…) — not an image, and blocked
      # by the browser when used as one.
      mediaUrl
      playbackUrl
      playbackContentType
      previewUrl
      # Poster + click-to-play for a link with rich media (Spotify, YouTube,
      # Netflix/Prime, …) — see RichMediaCard, the same fragment the memory
      # drawer's ContentDetails spreads.
      ...RichMediaData
      tags {
        id
        label
      }
    }
  }
`);

// Same write the memory drawer makes (UpdateContentDetail), so the page can edit
// the title as well as the text instead of the text alone.
const UPDATE_CONTENT_FIELDS = gql(`
  mutation UpdateContentPageFields($input: UpdateContentInput!) {
    updateContent(input: $input) {
      id
      title
      text
    }
  }
`);

export function ContentPage() {
  const { id } = useParams<{ id: string }>();

  const { data, loading, error, refetch } = useQuery(GET_CONTENT, {
    variables: {
      id: GlobalUID.encode('content', id!),
    },
  });

  const [updateContentFields] = useMutation(UPDATE_CONTENT_FIELDS);

  const contentItem = data?.content;

  const [editMode, setEditMode] = useState(false);

  usePageTitle(
    contentItem?.title ? `Content - ${contentItem.title} - Companion Memory` : 'Content - Companion Memory',
  );

  let content: ReactNode | null = null;

  if (loading) {
    content = <LoadingPage />;
  } else if (error) {
    // A failed fetch is not an absent record. Dropping `error` sent a 500, a
    // dead connection or an expired session down the branch below, which told
    // the owner their own content does not exist.
    content = (
      <ErrorState
        title="Could not load this content"
        description="This content is still here — this device could not reach it just now."
        onRetry={() => void refetch()}
      />
    );
  } else if (contentItem == null) {
    content = <EmptyState icon={<ContentIcon size={48} colorized={false} />} message="Content not found" />;
  } else {
    content = (
      <PageContent>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ContentIcon />
            <h1 className="text-2xl font-bold">{contentItem.title}</h1>
          </div>
          <div className="flex items-center gap-2">
            <ChatWithAgentMenu
              context={namedChatContext({
                title: contentItem.title,
                body: contentItem.text,
                sourceKind: 'ContentType',
                sourceId: contentItem.id,
              })}
            />
            <EntityEditToggle pressed={editMode} onPressedChange={setEditMode} />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="flex flex-col gap-4 md:col-span-2">
            {/* The drawer's field set and its media, so reaching this route directly
                does not silently drop the title editor and the image. */}
            <EntityFieldsCard
              title="Content"
              resetKey={contentItem.id}
              editMode={editMode}
              onEditModeChange={setEditMode}
              fields={[{ key: 'title', label: 'Title', value: contentItem.title ?? '' }]}
              metaItems={[{ label: 'Type', value: contentItem.mimetype ?? 'Content' }]}
              onSave={async (values) => {
                const result = await updateContentFields({
                  variables: { input: { id: contentItem.id, title: values.title } },
                });

                if (!result.data?.updateContent) {
                  throw new Error('Update was rejected');
                }
              }}
            >
              {/* A link with a resolved preview or a provider player shows THAT — the
                  poster, the facts, click-to-play — same as the memory drawer;
                  otherwise the linked image renders as before. */}
              {hasRichMedia(contentItem) ? (
                <RichMediaCard
                  content={contentItem}
                  title={contentItem.title}
                  url={contentItem.contentUrl ?? contentItem.sourceUrl}
                />
              ) : (
                contentItem.mimetype?.startsWith('image/') && (
                  <EntityMedia
                    src={resolveStaticUrl(
                      contentItem.mediaUrl ?? contentItem.contentUrl ?? contentItem.sourceUrl,
                    )}
                    previewSrc={resolveStaticUrl(contentItem.previewUrl)}
                    contentType={contentItem.mimetype}
                    alt={contentItem.title ?? ''}
                    fallbackHref={contentItem.contentUrl ?? contentItem.sourceUrl}
                  />
                )
              )}
            </EntityFieldsCard>

            <EntityGraph entityId={id!} />
          </div>
          <EntityTagsDescriptionCard
            entityType="content"
            entityId={id!}
            resetKey={contentItem.id}
            tags={contentItem.tags.map((t) => t.label)}
            description={contentItem.text}
            descriptionLabel="Text"
            editMode={editMode}
            onDescriptionSave={async (value) => {
              const result = await updateContentFields({
                variables: { input: { id: contentItem.id, text: value } },
              });

              // updateContent resolves to the content itself, or null when the write was rejected.
              if (!result.data?.updateContent) {
                throw new Error('Update was rejected');
              }
            }}
          />
        </div>

        <EntityRelationshipCards entityId={id!} />
        <EntityEvolutionPanel entityId={id!} />
      </PageContent>
    );
  }

  return <>{content}</>;
}
