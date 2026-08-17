import { useMemo, useState } from 'react';

import { useQuery } from '@apollo/client';
import { EmptyState, usePageTitle } from '@ci/common';
import { Input } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { MemoryHubShell } from '@/components/MemoryHub';
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
  const { data, loading, error } = useQuery(GET_TAGS);

  const sortedTags = useMemo(() => {
    const edges = data?.tags?.edges ?? [];

    return [...edges].sort((a, b) => a.node.label.toLowerCase().localeCompare(b.node.label.toLowerCase()));
  }, [data]);

  const filteredTags = useMemo(
    () => sortedTags.filter(({ node: tag }) => tag.label.toLowerCase().includes(searchQuery.toLowerCase())),
    [searchQuery, sortedTags],
  );

  return (
    <>
      <PageContent className="gap-4 p-0">
        <MemoryHubShell>
          <div className="flex flex-col gap-4 px-4 pb-4">
            <Input
              placeholder="Filter tags..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />

            {loading ? (
              <p className="text-sm text-muted-foreground">Loading tags…</p>
            ) : error ? (
              <EmptyState message={`Couldn't load tags: ${error.message}`} />
            ) : sortedTags.length === 0 ? (
              <EmptyState message="No tags yet. Tags appear as you organize events and other memory." />
            ) : filteredTags.length === 0 ? (
              <EmptyState message="No tags match your filter." />
            ) : (
              <div className="flex flex-wrap gap-2">
                {filteredTags.map(({ node: tag }) => (
                  <Link key={tag.id} to={`/memory?tags=${encodeURIComponent(tag.label)}`}>
                    <Tag text={tag.label} className="cursor-pointer" />
                  </Link>
                ))}
              </div>
            )}
          </div>
        </MemoryHubShell>
      </PageContent>
    </>
  );
}
