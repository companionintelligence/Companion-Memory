import { type ReactNode, useMemo, useState } from 'react';

import { useQuery } from '@apollo/client';
import { EmptyState, GlobalUID, LoadingPage, Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Input } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { Tag } from '@/components/Tag';
import { gql } from '@/graphql';

const GET_TAGS = gql(`
  query GetTags {
    tags {
      edges {
        node {
          id
          label
          description
        }
      }
    }
  }
`);

export function TagsPage() {
  usePageTitle('Tags - Companion Intelligence');

  const [searchQuery, setSearchQuery] = useState('');
  const { data, loading } = useQuery(GET_TAGS);

  const sortedTags = useMemo(() => {
    if (data == null) {
      return [];
    }

    return [...data.tags.edges].sort((a, b) =>
      a.node.label.toLowerCase().localeCompare(b.node.label.toLowerCase()),
    );
  }, [data]);

  let content: ReactNode | null = null;

  if (loading) {
    content = <LoadingPage />;
  } else if (data == null || data.tags.edges.length === 0) {
    content = <EmptyState message="No tags found" />;
  } else {
    const filteredTags = sortedTags.filter(({ node: tag }) =>
      tag.label.toLowerCase().includes(searchQuery.toLowerCase()),
    );

    content = (
      <PageContent>
        <Input
          placeholder="Filter tags..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />

        <div className="flex flex-wrap gap-2">
          {filteredTags.map(({ node: tag }) => (
            <Link key={tag.id} to={`/tags/${GlobalUID.parse('tag', tag.id)}`}>
              <Tag text={tag.label} className="cursor-pointer" />
            </Link>
          ))}
        </div>
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
              <Breadcrumb.Page>Tags</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      {content}
    </>
  );
}
