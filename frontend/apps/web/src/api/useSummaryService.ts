import { gql, useQuery } from '@apollo/client';

import { type Summary } from './types';

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
`;

interface GetSummaryResponse {
  summary: {
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
      events?: number;
      messages?: number;
      screenCaptures?: number;
      apiLogs?: number;
      positions?: number;
      activities?: number;
      measurements?: number;
    };
    dailyRhythm?: string[];
    productivityPatterns?: string[];
    socialInteractions?: string[];
    keyAccomplishments?: string[];
    moodIndicators?: string[];
    confidenceScore?: number;
    createdAt: string;
    updatedAt: string;
  } | null;
}

export function useSummaryService(id: string) {
  const { data, loading, error } = useQuery<GetSummaryResponse>(GET_SUMMARY, {
    variables: { id: btoa(`summary:${id}`) },
    skip: !id,
  });

  const summary: Summary | null = data?.summary
    ? {
        id: atob(data.summary.id).split(':')[1],
        title: data.summary.title,
        periodType: data.summary.periodType,
        periodStart: data.summary.periodStart,
        periodEnd: data.summary.periodEnd,
        summaryText: data.summary.summaryText,
        keyInsights: data.summary.keyInsights,
        notableEvents: data.summary.notableEvents,
        anomalies: data.summary.anomalies,
        tags: data.summary.tags,
        activityCounts: data.summary.activityCounts,
        dailyRhythm: data.summary.dailyRhythm,
        productivityPatterns: data.summary.productivityPatterns,
        socialInteractions: data.summary.socialInteractions,
        keyAccomplishments: data.summary.keyAccomplishments,
        moodIndicators: data.summary.moodIndicators,
      }
    : null;

  return [
    {
      data: summary,
      loading,
      error,
    },
  ];
}
