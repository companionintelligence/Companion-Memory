import { useCallback, useEffect, useState } from 'react';

import { apiKeyHeaders, buildApiUrl, fetchJson } from '@ci/common';

import { useSessionAuth } from '@/hooks';

export interface FeedQuestion {
  id: string;
  text: string;
  category?: string | null;
  questionType?: string | null;
  contextTags?: string[] | null;
  /** Feed queue row id — changes when the same question rotates to the back. */
  presentationId: string;
}

type ReturnType = [
  {
    question: FeedQuestion | null;
    loading: boolean;
    submitting: boolean;
    error: unknown | null;
  },
  {
    refetch: () => Promise<void>;
    submitAnswer: (input: { questionId: string; text: string }) => Promise<boolean>;
  },
];

/** Poll for a rotated question while one remains unanswered on the feed. */
const FEED_QUESTION_POLL_MS = 2 * 60 * 1000;

export function useFeedQuestionService(): ReturnType {
  // `ready`, not `authToken`: the token is the web JWT, which the native shell never has — its
  // credential is a keystore API key. Gating on the token meant the feed never asked a reflection
  // question on the phone (and answering was a silent no-op), though both routes take the key.
  const { ready, headers: sessionHeaders } = useSessionAuth();

  const [question, setQuestion] = useState<FeedQuestion | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const fetchUnansweredQuestion = useCallback(async () => {
    if (!ready) {
      setQuestion(null);
      setLoading(false);
      setError(null);

      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(buildApiUrl('/api/questions/unanswered'), {
        method: 'GET',
        headers: {
          ...apiKeyHeaders(),
          ...sessionHeaders,
          'Content-Type': 'application/json',
        },
      });

      if (response.status === 204) {
        setQuestion(null);

        return;
      }

      if (!response.ok) {
        throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as Omit<FeedQuestion, 'presentationId'> & {
        presentationId?: string;
      };

      setQuestion({
        ...data,
        presentationId: data.presentationId ?? data.id,
      });
    } catch (err) {
      setError(err);
      setQuestion(null);
    } finally {
      setLoading(false);
    }
  }, [ready, sessionHeaders]);

  const submitAnswer = useCallback(
    async ({ questionId, text }: { questionId: string; text: string }): Promise<boolean> => {
      if (!ready) {
        return false;
      }

      setSubmitting(true);
      setError(null);

      try {
        await fetchJson('/api/answers', {
          method: 'POST',
          headers: {
            ...sessionHeaders,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text,
            question: {
              id: questionId,
            },
          }),
        });

        await fetchUnansweredQuestion();

        return true;
      } catch (err) {
        setError(err);

        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [ready, sessionHeaders, fetchUnansweredQuestion],
  );

  useEffect(() => {
    void fetchUnansweredQuestion();
  }, [fetchUnansweredQuestion]);

  // Re-fetch periodically so stale unanswered questions can rotate server-side.
  useEffect(() => {
    if (!ready || !question) {
      return;
    }

    const handle = setInterval(() => {
      void fetchUnansweredQuestion();
    }, FEED_QUESTION_POLL_MS);

    return () => clearInterval(handle);
  }, [ready, question, fetchUnansweredQuestion]);

  return [
    {
      question,
      loading,
      submitting,
      error,
    },
    {
      refetch: fetchUnansweredQuestion,
      submitAnswer,
    },
  ];
}
