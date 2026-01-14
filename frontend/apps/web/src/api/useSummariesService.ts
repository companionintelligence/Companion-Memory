import { useEffect } from 'react';

import { gql, useLazyQuery } from '@apollo/client';

import { useAuth } from '@/hooks';

import { type Summary } from './types';

const GET_SUMMARIES = gql`
  query GetSummaries($first: Int) {
    summaries(first: $first) {
      edges {
        node {
          id
          title
          periodType
          periodStart
          periodEnd
          summaryText
          keyInsights
          notableEvents
          anomalies
          tags
          activityCounts {
            total
            browserActivity
            communications
            files
          }
          dailyRhythm
          productivityPatterns
          socialInteractions
          keyAccomplishments
          moodIndicators
        }
      }
      pageInfo {
        hasNextPage
      }
      totalCount
    }
  }
`;

interface GetSummariesResponse {
  summaries: {
    edges: {
      node: {
        id: string;
        title: string | null;
        periodType: string;
        periodStart: string;
        periodEnd: string;
        summaryText: string;
        keyInsights: string[];
        notableEvents: string[];
        anomalies: string[];
        tags: string[];
        activityCounts: {
          total: number;
          browserActivity?: number;
          communications?: number;
          files?: number;
        };
        dailyRhythm?: string[];
        productivityPatterns?: string[];
        socialInteractions?: string[];
        keyAccomplishments?: string[];
        moodIndicators?: string[];
      };
    }[];
    pageInfo: {
      hasNextPage: boolean;
    };
    totalCount: number;
  };
}

export function useSummariesService(limit: number = 10) {
  const [{ authToken, user, loading: authLoading }] = useAuth();

  const shouldSkipQuery = authLoading || !authToken || !user;

  const [fetchSummaries, { data, loading: summariesLoading, error }] = useLazyQuery<GetSummariesResponse>(
    GET_SUMMARIES,
    {
      fetchPolicy: 'cache-and-network',
      notifyOnNetworkStatusChange: true,
    },
  );

  useEffect(() => {
    if (shouldSkipQuery || !authToken) {
      return;
    }

    fetchSummaries({
      variables: { first: limit },
      context: {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      },
    });
  }, [fetchSummaries, shouldSkipQuery, limit, authToken]);

  const isUnauthorizedError = Boolean(
    error?.graphQLErrors?.some((graphQLError) => graphQLError.message === 'User authentication required'),
  );

  if (error && !isUnauthorizedError) {
    console.error('GraphQL error in useSummariesService:', error);
  }

  if (data) {
    console.log('Summaries data received:', data);
  }

  const summaries: Summary[] =
    data?.summaries.edges.map(({ node }) => ({
      id: atob(node.id).split(':')[1],
      title: node.title,
      periodType: node.periodType,
      periodStart: node.periodStart,
      periodEnd: node.periodEnd,
      summaryText: node.summaryText,
      keyInsights: node.keyInsights,
      notableEvents: node.notableEvents,
      anomalies: node.anomalies,
      tags: node.tags,
      activityCounts: node.activityCounts,
      dailyRhythm: node.dailyRhythm,
      productivityPatterns: node.productivityPatterns,
      socialInteractions: node.socialInteractions,
      keyAccomplishments: node.keyAccomplishments,
      moodIndicators: node.moodIndicators,
    })) || [];

  return [
    {
      data: summaries,
      loading: shouldSkipQuery ? authLoading : summariesLoading,
      error: isUnauthorizedError ? undefined : error,
    },
  ];
}
