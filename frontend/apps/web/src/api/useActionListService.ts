import { gql, useMutation, useQuery } from '@apollo/client';

import { type Action } from './types';

const GET_FEED_ACTIONS = gql(`
  query GetFeedActions($limit: Int) {
    feedActions(limit: $limit) {
      id
      title
      text
      imageUrl
      priority
      seen
      dismissed
      metadata {
        seen
        type
        context
        relatedPerson
      }
      thread {
        id
      }
    }
  }
`);

const MARK_ACTION_AS_SEEN = gql(`
  mutation MarkActionAsSeen($id: ID!) {
    markActionAsSeen(id: $id) {
      id
      seen
    }
  }
`);

const MARK_ACTION_AS_DISMISSED = gql(`
  mutation MarkActionAsDismissed($id: ID!) {
    markActionAsDismissed(id: $id) {
      id
      dismissed
    }
  }
`);

interface FeedActionNode {
  id: string;
  title: string;
  text: string;
  imageUrl?: string | null;
  priority?: number | null;
  seen: boolean;
  dismissed: boolean;
  metadata: {
    seen: boolean;
    type?: string | null;
    context?: string | null;
    relatedPerson?: string | null;
  };
  thread?: {
    id: string;
  } | null;
}

interface FeedActionsQueryResult {
  feedActions: FeedActionNode[];
}

function decodeGlobalId(globalId: string): string {
  try {
    const decoded = atob(globalId);
    const [, id] = decoded.split(':');

    return id ?? globalId;
  } catch {
    return globalId;
  }
}

export function useActionListService(limit: number = 5) {
  const { data, loading, error, refetch } = useQuery<FeedActionsQueryResult>(GET_FEED_ACTIONS, {
    variables: { limit },
  });

  const [markAsSeen] = useMutation(MARK_ACTION_AS_SEEN);
  const [markAsDismissed] = useMutation(MARK_ACTION_AS_DISMISSED);

  const actions: Action[] =
    data?.feedActions
      ?.filter((node): node is NonNullable<typeof node> => !!node)
      .map((node) => ({
        id: decodeGlobalId(node.id),
        title: node.title,
        text: node.text,
        imageUrl: node.imageUrl ?? undefined,
        priority: node.priority ?? undefined,
        seen: node.seen,
        dismissed: node.dismissed,
        metadata: node.metadata,
        threadId: node.thread?.id ? decodeGlobalId(node.thread.id) : undefined,
        tags: [],
      })) || [];

  const markActionAsSeen = async (actionId: string) => {
    const gid = btoa(`action:${actionId}`);
    await markAsSeen({ variables: { id: gid } });
  };

  const markActionAsDismissed = async (actionId: string) => {
    const gid = btoa(`action:${actionId}`);
    await markAsDismissed({ variables: { id: gid } });
    await refetch();
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
      markActionAsDismissed,
    },
  ] as const;
}
