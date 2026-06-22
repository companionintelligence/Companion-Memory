import { useMutation } from '@apollo/client';

import { gql } from '@/graphql';

const TAG_ENTITIES = gql(`
  mutation TagEntities($input: TagEntitiesInput!) {
    tagEntities(input: $input) {
      ... on Node {
        id
      }

      ... on Taggable {
        tags {
          id
          label
        }
      }
    }
  }
`);

const UNTAG_ENTITIES = gql(`
  mutation UntagEntities($input: TagEntitiesInput!) {
    untagEntities(input: $input) {
      ... on Node {
        id
      }

      ... on Taggable {
        tags {
          id
          label
        }
      }
    }
  }
`);

export function useTagEntityService() {
  const [tagEntitiesMutation] = useMutation(TAG_ENTITIES);
  const [untagEntitiesMutation] = useMutation(UNTAG_ENTITIES);

  const tagEntities = async (ids: string[], labels: string[]) => {
    return tagEntitiesMutation({
      variables: {
        input: {
          ids,
          labels,
        },
      },
      update(cache, { data }) {
        if (!data?.tagEntities) {
          return;
        }

        // Evict the root `tags` query so the explorer's tag filter (which
        // autocompletes from the tag list) refetches — handles a freshly
        // created tag showing up in suggestions.
        cache.evict({
          id: 'ROOT_QUERY',
          fieldName: 'tags',
        });

        cache.gc();
      },
    });
  };

  const untagEntities = async (ids: string[], labels: string[]) => {
    return untagEntitiesMutation({
      variables: {
        input: {
          ids,
          labels,
        },
      },
      update(cache) {
        // Refresh the root `tags` list so a tag that no longer has any entities
        // drops out of the explorer's filter suggestions. (The old per-TagType
        // `entities` eviction is gone with the Tags page — nothing queries it.)
        cache.evict({
          id: 'ROOT_QUERY',
          fieldName: 'tags',
        });

        cache.gc();
      },
    });
  };

  return {
    tagEntities,
    untagEntities,
  };
}
