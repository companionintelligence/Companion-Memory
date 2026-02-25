import { gql, useQuery } from '@apollo/client';

const FEED_BADGE_ACTION_LIMIT = 5;
const FEED_BADGE_SUMMARY_LIMIT = 10;

const GET_FEED_BADGE_COUNT = gql(`
  query GetFeedBadgeCount($actionLimit: Int, $summaryFirst: Int) {
    feedActions(limit: $actionLimit) {
      id
      seen
      dismissed
    }
    summaries(first: $summaryFirst) {
      edges {
        node {
          id
          seen
          dismissed
        }
      }
    }
  }
`);

interface FeedBadgeActionNode {
  id: string;
  seen: boolean;
  dismissed: boolean;
}

interface FeedBadgeSummaryNode {
  id: string;
  seen: boolean;
  dismissed: boolean;
}

interface FeedBadgeCountQueryResult {
  feedActions: FeedBadgeActionNode[];
  summaries: {
    edges: Array<{
      node: FeedBadgeSummaryNode;
    }>;
  };
}

interface FeedBadgeCountQueryVariables {
  actionLimit: number;
  summaryFirst: number;
}

export function useFeedBadgeCount() {
  const { data } = useQuery<FeedBadgeCountQueryResult, FeedBadgeCountQueryVariables>(GET_FEED_BADGE_COUNT, {
    variables: {
      actionLimit: FEED_BADGE_ACTION_LIMIT,
      summaryFirst: FEED_BADGE_SUMMARY_LIMIT,
    },
    fetchPolicy: 'no-cache',
    notifyOnNetworkStatusChange: true,
  });

  const unseenActionsCount =
    data?.feedActions?.filter((action) => action.dismissed !== true && action.seen !== true).length ?? 0;
  const unseenSummariesCount =
    data?.summaries?.edges?.filter(({ node }) => node.dismissed !== true && node.seen !== true).length ?? 0;

  return unseenActionsCount + unseenSummariesCount;
}
