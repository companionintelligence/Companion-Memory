import { gql, useQuery } from '@apollo/client';

import { useFeatures } from '@/common/feature';

const FEED_BADGE_ACTION_LIMIT = 5;
const FEED_BADGE_SUMMARY_LIMIT = 10;

const FEED_BADGE_ACTION_FRAGMENT = gql`
  fragment FeedBadgeAction on ActionType {
    id
    seen
    dismissed
  }
`;

const FEED_BADGE_SUMMARY_FRAGMENT = gql`
  fragment FeedBadgeSummary on SummaryType {
    id
    seen
    dismissed
  }
`;

const GET_FEED_BADGE_COUNT = gql`
  query GetFeedBadgeCount($actionLimit: Int, $summaryFirst: Int) {
    feedActions(limit: $actionLimit) {
      ...FeedBadgeAction
    }
    summaries(first: $summaryFirst) {
      edges {
        node {
          ...FeedBadgeSummary
        }
      }
    }
  }
  ${FEED_BADGE_ACTION_FRAGMENT}
  ${FEED_BADGE_SUMMARY_FRAGMENT}
`;

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
  const { isFeatureEnabled } = useFeatures();
  const actionsEnabled = isFeatureEnabled('actions');
  /**
   * Today is the only surface that lists these actions and summaries. With
   * `today.page` off nothing can open them, so a badge would be a red dot the
   * owner cannot clear — it counted unseen rows for months while the page that
   * showed them was unrouted. Count nothing, and don't ask the API either.
   */
  const todayPageEnabled = isFeatureEnabled('today.page');

  const { data } = useQuery<FeedBadgeCountQueryResult, FeedBadgeCountQueryVariables>(GET_FEED_BADGE_COUNT, {
    variables: {
      actionLimit: actionsEnabled ? FEED_BADGE_ACTION_LIMIT : 0,
      summaryFirst: FEED_BADGE_SUMMARY_LIMIT,
    },
    skip: !todayPageEnabled,
    fetchPolicy: 'no-cache',
    notifyOnNetworkStatusChange: true,
  });

  if (!todayPageEnabled) {
    return 0;
  }

  const unseenActionsCount = actionsEnabled
    ? (data?.feedActions?.filter((action) => action.dismissed !== true && action.seen !== true).length ?? 0)
    : 0;
  const unseenSummariesCount =
    data?.summaries?.edges?.filter(({ node }) => node.dismissed !== true && node.seen !== true).length ?? 0;

  return unseenActionsCount + unseenSummariesCount;
}
