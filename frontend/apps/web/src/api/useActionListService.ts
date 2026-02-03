import { gql, useMutation, useQuery } from '@apollo/client';

import { type Action } from './types';

const GET_FEED_ACTIONS = gql`
  query GetFeedActions($limit: Int) {
    feedActions(limit: $limit) {
      id
      title
      text
      imageUrl
      priority
      metadata {
        seen
        type
        context
        relatedPerson
      }
      thread {
        id
      }
      tags {
        id
        label
      }
    }
  }
`;

const MARK_ACTION_AS_SEEN = gql`
  mutation MarkActionAsSeen($id: ID!) {
    markActionAsSeen(id: $id) {
      id
      metadata {
        seen
      }
    }
  }
`;

interface GetFeedActionsResponse {
  feedActions: {
    id: string;
    title: string;
    text: string;
    imageUrl?: string;
    priority?: number;
    metadata: {
      seen: boolean;
      type?: string;
      context?: string;
      relatedPerson?: string;
    };
    thread?: {
      id: string;
    };
    tags: {
      id: string;
      label: string;
    }[];
  }[];
}

export function useActionListService(limit: number = 5) {
  const { data, loading, error, refetch } = useQuery<GetFeedActionsResponse>(GET_FEED_ACTIONS, {
    variables: { limit },
  });

  const [markAsSeen] = useMutation(MARK_ACTION_AS_SEEN);

  const actions: Action[] =
    data?.feedActions
      ?.filter((node): node is NonNullable<typeof node> => !!node)
      .map((node) => ({
        id: node.id ? atob(node.id).split(':')[1] : '',
        title: node.title,
        text: node.text,
        imageUrl: node.imageUrl,
        priority: node.priority,
        metadata: node.metadata,
        threadId: node.thread?.id ? atob(node.thread.id).split(':')[1] : undefined,
        tags: node.tags?.map((t) => t.label) || [],
      })) || [];

  const markActionAsSeen = async (actionId: string) => {
    // Encode the ID back to GlobalUID format
    const gid = btoa(`action:${actionId}`);
    await markAsSeen({ variables: { id: gid } });
    refetch();
  };

  return [
    {
      data: actions,
      loading,
      error,
    },
    {
      refetch,
      markActionAsSeen,
    },
  ] as const;
}
