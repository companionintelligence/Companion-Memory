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

        // Evict the root `tags` query so the TagsPage refetches the list. This
        // handles the case where a new tag is created.
        cache.evict({
          id: 'ROOT_QUERY',
          fieldName: 'tags',
        });

        // Evict the `entities` field from the tags that were just added. This
        // ensures that when navigating to a Tag page, the entities list will be
        // refetched and include the newly tagged entity.
        //
        // Note that the mutation returns EntityTagType, but the TagPage queries
        // TagType, but they share the same ID, so we construct the TagType
        // cache key manually.
        for (const entity of data.tagEntities) {
          if ('tags' in entity && entity.tags) {
            for (const tag of entity.tags) {
              cache.evict({
                id: `TagType:${tag.id}`,
                fieldName: 'entities',
              });
            }
          }
        }

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
        // For untagging, we don't have access to the removed tag IDs (they're
        // no longer in the entity's tags list). We need to evict the `entities`
        // field from all TagType objects in the cache to ensure stale data is
        // never shown.
        cache.evict({
          id: 'ROOT_QUERY',
          fieldName: 'tag',
        });

        // Also evict all TagType entities fields
        const cacheData = cache.extract();

        for (const key of Object.keys(cacheData)) {
          if (key.startsWith('TagType:')) {
            cache.evict({
              id: key,
              fieldName: 'entities',
            });
          }
        }

        cache.gc();
      },
    });
  };

  return {
    tagEntities,
    untagEntities,
  };
}
