import { gql, useQuery } from '@apollo/client';

interface InsightNode {
  title: string;
  summaryText: string;
  keyActions: string[];
  relevanceScore: number;
  tags: string[];
  relatedEntityIds?: string[] | null;
}

interface SummaryDetail {
  id: string;
  title?: string | null;
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
    browserActivity?: number | null;
    communications?: number | null;
    files?: number | null;
    events?: number | null;
    messages?: number | null;
  };
  insights: InsightNode[];
  dailyRhythm?: string[] | null;
  productivityPatterns?: string[] | null;
  socialInteractions?: string[] | null;
  keyAccomplishments?: string[] | null;
  moodIndicators?: string[] | null;
  confidenceScore?: number | null;
  createdAt: string;
  updatedAt: string;
}

interface GetSummaryQueryResult {
  summary?: SummaryDetail | null;
}

interface GetSummaryQueryVariables {
  id: string;
}

const GET_SUMMARY = gql`
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
      }
      insights {
        title
        summaryText
        keyActions
        relevanceScore
        tags
        relatedEntityIds
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
`;

export function useSummaryService(id: string) {
  const { data, loading, error } = useQuery<GetSummaryQueryResult, GetSummaryQueryVariables>(GET_SUMMARY, {
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
