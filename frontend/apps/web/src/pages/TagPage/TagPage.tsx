import { type ReactNode } from 'react';

import { useQuery } from '@apollo/client';
import { EmptyState, GlobalUID, LoadingPage, Portal, usePageTitle } from '@ci/common';
import { Breadcrumb } from '@ci/shadcn';
import { useParams, Link, useNavigate } from 'react-router-dom';

import {
  ActionGridItem,
  BrowserActivityGridItem,
  CommunicationGridItem,
  ConceptGridItem,
  ContentGridItem,
  EntityGrid,
  EventGridItem,
  FileGridItem,
  ItemGridItem,
  NoteGridItem,
  PersonGridItem,
  PlaceGridItem,
  ThreadGridItem,
} from '@/components/entities';
import { TagIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';
import { Tag } from '@/components/Tag';
import { gql } from '@/graphql';

const GET_TAG = gql(`
  query GetTag($id: ID!) {
    tag(id: $id) {
      id
      label
      description

      entities {
        edges {
          node {
            __typename

            ... on Node {
              id
            }

            ...ActionGridItemData
            ...BrowserActivityGridItemData
            ...CommunicationGridItemData
            ...ConceptGridItemData
            ...ContentGridItemData
            ...EventGridItemData
            ...FileGridItemData
            ...NoteGridItemData
            ...ItemGridItemData
            ...PersonGridItemData
            ...PlaceGridItemData
            ...ThreadGridItemData
          }
        }
      }
    }
  }
`);

export function TagPage() {
  const { id } = useParams<{ id: string }>();

  const navigate = useNavigate();

  const { data, loading } = useQuery(GET_TAG, {
    variables: { id: GlobalUID.encode('tag', id!) },
    skip: !id || id === 'new',
  });

  const tag = data?.tag;

  usePageTitle(tag?.label ? `Tag - ${tag.label} - Companion Intelligence` : 'Tag - Companion Intelligence');

  let content: ReactNode | null = null;

  if (loading) {
    content = <LoadingPage />;
  } else if (tag == null) {
    content = <EmptyState message="Tag not found" />;
  } else {
    content = (
      <PageContent>
        {tag.entities.edges.length === 0 ? (
          <EmptyState
            icon={<TagIcon size={48} colorized={false} />}
            message="No entities tagged with this tag."
          />
        ) : (
          <EntityGrid className="p-4 pt-0">
            {tag.entities.edges.map(({ node }) => {
              switch (node.__typename) {
                case 'ActionType':
                  return <ActionGridItem key={node.id} action={node} onClick={() => {}} />;

                case 'BrowserActivityType':
                  return <BrowserActivityGridItem key={node.id} browserActivity={node} onClick={() => {}} />;

                case 'CommunicationType':
                  return (
                    <CommunicationGridItem
                      key={node.id}
                      communication={node}
                      onClick={() => {
                        navigate(`/communications/${GlobalUID.parse('communication', node.id)}`);
                      }}
                    />
                  );

                case 'ConceptType':
                  return (
                    <ConceptGridItem
                      key={node.id}
                      concept={node}
                      onClick={() => {
                        navigate(`/concepts/${GlobalUID.parse('concept', node.id)}`);
                      }}
                    />
                  );

                case 'ContentType':
                  return (
                    <ContentGridItem
                      key={node.id}
                      content={node}
                      onClick={() => {
                        navigate(`/content/${GlobalUID.parse('content', node.id)}`);
                      }}
                    />
                  );

                case 'EventType':
                  return (
                    <EventGridItem
                      key={node.id}
                      event={node}
                      onClick={() => {
                        navigate(`/events/${GlobalUID.parse('event', node.id)}`);
                      }}
                    />
                  );

                case 'FileType':
                  return <FileGridItem key={node.id} file={node} />;

                case 'ItemType':
                  return (
                    <ItemGridItem
                      key={node.id}
                      item={node}
                      onClick={() => {
                        navigate(`/items/${GlobalUID.parse('item', node.id)}`);
                      }}
                    />
                  );

                case 'NoteType':
                  return (
                    <NoteGridItem
                      key={node.id}
                      note={node}
                      onClick={() => {
                        navigate(`/notes/${GlobalUID.parse('note', node.id)}`);
                      }}
                    />
                  );

                case 'PersonType':
                  return (
                    <PersonGridItem
                      key={node.id}
                      person={node}
                      onClick={() => {
                        navigate(`/people/${GlobalUID.parse('person', node.id)}`);
                      }}
                    />
                  );

                case 'PlaceType':
                  return (
                    <PlaceGridItem
                      key={node.id}
                      place={node}
                      onClick={() => {
                        navigate(`/places/${GlobalUID.parse('place', node.id)}`);
                      }}
                    />
                  );

                case 'ThreadType':
                  return (
                    <ThreadGridItem
                      key={node.id}
                      thread={node}
                      onClick={() => {
                        navigate(`/chat/${GlobalUID.parse('thread', node.id)}`);
                      }}
                    />
                  );

                default:
                  return null;
              }
            })}
          </EntityGrid>
        )}
      </PageContent>
    );
  }

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link asChild>
                <Link to="/feed">Companion</Link>
              </Breadcrumb.Link>
            </Breadcrumb.Item>

            <Breadcrumb.Separator className="hidden md:block" />

            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link asChild>
                <Link to="/tags">Tags</Link>
              </Breadcrumb.Link>
            </Breadcrumb.Item>

            {tag && (
              <>
                <Breadcrumb.Separator className="hidden md:block" />

                <Breadcrumb.Item>
                  <Breadcrumb.Page>
                    <Tag text={tag.label} />
                  </Breadcrumb.Page>
                </Breadcrumb.Item>
              </>
            )}
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      {content}
    </>
  );
}
