import { gql, useMutation, useQuery } from '@apollo/client';
import { useMemo, useState } from 'react';

interface InsightNode {
  title: string;
  summaryText: string;
  keyActions: string[];
  relevanceScore: number;
  tags: string[];
  relatedEntityIds?: string[] | null;
}

interface SummaryNode {
  id: string;
  title?: string | null;
  periodType: string;
  seen: boolean;
  dismissed: boolean;
  summaryText: string;
  keyInsights: string[];
  tags: string[];
  activityCounts: {
    total: number;
  };
  insights: InsightNode[];
}

interface GetSummariesQueryResult {
  summaries: {
    edges: Array<{
      node: SummaryNode;
    }>;
    pageInfo: {
      hasNextPage: boolean;
    };
    totalCount: number;
  };
}

interface GetSummariesQueryVariables {
  first?: number;
}

interface MarkSummaryAsSeenMutationResult {
  markSummaryAsSeen?: {
    id: string;
    seen: boolean;
  } | null;
}

interface MarkSummaryAsSeenMutationVariables {
  id: string;
}

interface MarkSummaryAsDismissedMutationResult {
  markSummaryAsDismissed?: {
    id: string;
    dismissed: boolean;
  } | null;
}

interface MarkSummaryAsDismissedMutationVariables {
  id: string;
}

const GET_SUMMARIES = gql`
  query GetSummaries($first: Int) {
    summaries(first: $first) {
      edges {
        node {
          id
          title
          periodType
          seen
          dismissed
          summaryText
          keyInsights
          tags
          activityCounts {
            total
          }
          insights {
            title
            summaryText
            keyActions
            relevanceScore
            tags
            relatedEntityIds
          }
        }
      }
      pageInfo {
        hasNextPage
      }
      totalCount
    }
  }
`;

const MARK_SUMMARY_AS_SEEN = gql`
  mutation MarkSummaryAsSeen($id: ID!) {
    markSummaryAsSeen(id: $id) {
      id
      seen
    }
  }
`;

const MARK_SUMMARY_AS_DISMISSED = gql`
  mutation MarkSummaryAsDismissed($id: ID!) {
    markSummaryAsDismissed(id: $id) {
      id
      dismissed
    }
  }
`;

export function useSummariesService(first?: number) {
  const { data, loading, error, refetch } = useQuery<GetSummariesQueryResult, GetSummariesQueryVariables>(
    GET_SUMMARIES,
    {
      variables: { first },
      fetchPolicy: 'cache-and-network',
      notifyOnNetworkStatusChange: true,
    },
  );
  const [markSeenMutation] = useMutation<MarkSummaryAsSeenMutationResult, MarkSummaryAsSeenMutationVariables>(
    MARK_SUMMARY_AS_SEEN,
  );
  const [markDismissedMutation] = useMutation<
    MarkSummaryAsDismissedMutationResult,
    MarkSummaryAsDismissedMutationVariables
  >(MARK_SUMMARY_AS_DISMISSED, {
    update(cache, { data: mutationData }) {
      const updated = mutationData?.markSummaryAsDismissed;
      if (!updated) {
        return;
      }

      const existing = cache.readQuery<GetSummariesQueryResult, GetSummariesQueryVariables>({
        query: GET_SUMMARIES,
        variables: { first },
      });

      if (!existing?.summaries?.edges) {
        return;
      }

      const newEdges = existing.summaries.edges.map((edge) =>
        edge.node.id === updated.id
          ? {
              ...edge,
              node: {
                ...edge.node,
                dismissed: updated.dismissed,
              },
            }
          : edge,
      );

      cache.writeQuery<GetSummariesQueryResult, GetSummariesQueryVariables>({
        query: GET_SUMMARIES,
        variables: { first },
        data: {
          ...existing,
          summaries: {
            ...existing.summaries,
            edges: newEdges,
          },
        },
      });
    },
  });
  const [mutationError, setMutationError] = useState<Error | null>(null);

  const summaries: SummaryNode[] = useMemo(
    () => data?.summaries?.edges.map(({ node }) => node) || [],
    [data],
  );

  const markSummaryAsSeen = async (id: string) => {
    try {
      const result = await markSeenMutation({ variables: { id } });
      setMutationError(null);
      await refetch();
      return result;
    } catch (err) {
      setMutationError(err as Error);
      throw err;
    }
  };

  const markSummaryAsDismissed = async (id: string) => {
    try {
      const result = await markDismissedMutation({ variables: { id } });
      setMutationError(null);
      return result;
    } catch (err) {
      setMutationError(err as Error);
      throw err;
    }
  };

  return [
    {
      data: summaries,
      loading: loading,
      error: error,
      mutationError: mutationError,
    },
    {
      refetch,
      markSummaryAsSeen,
      markSummaryAsDismissed,
    },
  ] as const;
}
