import { gql } from '@apollo/client';
import { useMutation, useQuery } from '@apollo/client/react';

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
    __typename?: 'SummaryType';
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

/**
 * Insights are generated one at a time by a background workflow and stored as
 * they land, so the feed polls to pick them up as they appear. There is no
 * subscription infrastructure; polling is the proportional mechanism.
 */
const SUMMARIES_POLL_INTERVAL_MS = 45_000;

export function useSummariesService(first?: number) {
  const { data, loading, error, refetch } = useQuery<GetSummariesQueryResult, GetSummariesQueryVariables>(
    GET_SUMMARIES,
    {
      variables: { first },
      fetchPolicy: 'cache-and-network',
      notifyOnNetworkStatusChange: true,
      pollInterval: SUMMARIES_POLL_INTERVAL_MS,
      // Don't burn requests while the tab is in the background.
      skipPollAttempt: () => document.hidden,
    },
  );
  const [markSeenMutation] = useMutation<MarkSummaryAsSeenMutationResult, MarkSummaryAsSeenMutationVariables>(
    MARK_SUMMARY_AS_SEEN,
  );
  const [markDismissedMutation] = useMutation<
    MarkSummaryAsDismissedMutationResult,
    MarkSummaryAsDismissedMutationVariables
  >(MARK_SUMMARY_AS_DISMISSED);

  const summaries: SummaryNode[] = data?.summaries?.edges.map(({ node }) => node) || [];

  const markSummaryAsSeen = async (id: string) => {
    await markSeenMutation({
      variables: { id },
      optimisticResponse: {
        markSummaryAsSeen: {
          __typename: 'SummaryType',
          id,
          seen: true,
        },
      },
    });
  };

  const markSummaryAsDismissed = async (id: string) => {
    await markDismissedMutation({ variables: { id } });
    await refetch();
  };

  return [
    {
      data: summaries,
      // Only surface loading before the first result: polls also flip Apollo's
      // loading flag (notifyOnNetworkStatusChange), and consumers swap their
      // whole view for a spinner on it — without this guard the page would
      // flash on every poll.
      loading: loading && data === undefined,
      error: error,
    },
    {
      refetch,
      markSummaryAsSeen,
      markSummaryAsDismissed,
    },
  ] as const;
}
