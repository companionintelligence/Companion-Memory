import { useQuery } from '@apollo/client';

import { gql } from '@/graphql';

const GET_SUMMARY = gql(`
  query GetSummary($id: ID!) {
    summary(id: $id) {
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
        events
        messages
        screenCaptures
        apiLogs
        positions
        activities
        measurements
      }
      dailyRhythm
      productivityPatterns
      socialInteractions
      keyAccomplishments
      moodIndicators
      confidenceScore
      createdAt
      updatedAt
    }
  }
`);

export function useSummaryService(id: string) {
  const { data, loading, error } = useQuery(GET_SUMMARY, {
    variables: { id: btoa(`summary:${id}`) },
    skip: !id,
  });

  return [
    {
      data: data?.summary ?? null,
      loading,
      error,
    },
  ] as const;
}
