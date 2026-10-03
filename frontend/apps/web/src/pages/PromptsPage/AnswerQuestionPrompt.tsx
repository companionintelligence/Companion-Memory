import { useState, useEffect, useCallback, useRef, type FormEvent } from 'react';

import { apiKeyHeaders, buildApiUrl } from '@ci/common';
import { Button, Card, Textarea, Spinner } from '@ci/shadcn';
import { Send } from '@ci/shadcn/icons';

import { useSessionAuth } from '@/hooks';

interface Question {
  id: string;
  text: string;
  category?: string;
  /** `ci.feed_queue.feed_queue_id` for this presentation. Needed by Skip. */
  presentationId?: string;
}

interface Props {
  onAnswerSubmitted?: () => void;
}

export function AnswerQuestionPrompt({ onAnswerSubmitted }: Props) {
  // `ready`, not `authToken`: the token is the web JWT, which the native shell never has — its
  // credential is a keystore API key (`apiKeyHeaders`). Gating on the token left the card spinning.
  const { ready, headers: sessionHeaders } = useSessionAuth();
  const [question, setQuestion] = useState<Question | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchingQuestion, setFetchingQuestion] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [charCount, setCharCount] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);

  const fetchUnansweredQuestion = useCallback(async () => {
    if (!ready) {
      return;
    }

    try {
      setFetchingQuestion(true);
      setError(null);

      const response = await fetch(buildApiUrl('/api/questions/unanswered'), {
        headers: {
          ...apiKeyHeaders(),
          ...sessionHeaders,
          'Content-Type': 'application/json',
        },
      });

      if (response.status === 204) {
        // No unanswered questions - only clear if we truly have no questions
        setQuestion(null);
        setFetchingQuestion(false);

        return;
      }

      if (!response.ok) {
        throw new Error(`Failed to fetch reflection: ${response.statusText}`);
      }

      const data = await response.json();
      // Update question - this will smoothly transition the question text
      setQuestion(data);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch reflection';
      setError(errorMessage);
      console.error('Error fetching unanswered question:', err);
      // Don't clear question on error - keep showing current one
    } finally {
      setFetchingQuestion(false);
    }
  }, [ready, sessionHeaders]);

  useEffect(() => {
    fetchUnansweredQuestion();
  }, [ready, sessionHeaders]);

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();

      if (!question || !ready) {
        return;
      }

      const formData = new FormData(e.currentTarget);
      const answerText = (formData.get('answer') as string) || '';
      const trimmedText = answerText.trim();

      if (!trimmedText) {
        setError('Answer text is required');

        return;
      }

      if (trimmedText.length > 5000) {
        setError('Answer text must be 5000 characters or less');

        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = await fetch(buildApiUrl('/api/answers'), {
          method: 'POST',
          headers: {
            ...apiKeyHeaders(),
            ...sessionHeaders,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: trimmedText,
            question: {
              id: question.id,
            },
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.message || `Failed to submit answer: ${response.statusText}`);
        }

        // Reset form and fetch next question
        formRef.current?.reset();
        setCharCount(0);
        onAnswerSubmitted?.();
        // Keep current question visible while fetching next one to prevent flash
        await fetchUnansweredQuestion();
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to submit answer';
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    },
    [question, ready, sessionHeaders, onAnswerSubmitted, fetchUnansweredQuestion],
  );

  /**
   * `findOneUnanswered` deterministically returns the front of the queue —
   * refetching alone hands back the identical question. This used to set
   * `dismissed` and unmount the card instead, which looked like "moved on"
   * but only hid it for the current mount: reload the page and the same
   * question is back, with no memory of having been skipped. `POST
   * /questions/unanswered/skip` moves the front-of-queue row to the back
   * server-side first, so the follow-up fetch genuinely returns a different
   * one (or nothing, if the queue only had this one question).
   */
  const handleDismiss = useCallback(() => {
    if (!ready || !question?.presentationId) {
      setDismissed(true);

      return;
    }

    void fetch(buildApiUrl('/api/questions/unanswered/skip'), {
      method: 'POST',
      headers: {
        ...apiKeyHeaders(),
        ...sessionHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ presentationId: question.presentationId }),
    })
      .catch(() => undefined)
      .then(() => fetchUnansweredQuestion());
  }, [ready, sessionHeaders, question, fetchUnansweredQuestion]);

  // Don't render if dismissed or no question and not loading
  if (dismissed || (!question && !fetchingQuestion)) {
    return null;
  }

  return (
    <Card className="p-4 mb-4 border-primary/20 bg-primary/5">
      {fetchingQuestion && !question ? (
        <div className="flex items-center gap-2">
          <Spinner variant="circle" className="h-4 w-4" />
          <span className="text-sm text-muted-foreground">Loading reflection...</span>
        </div>
      ) : question ? (
        <form ref={formRef} onSubmit={handleSubmit} className="space-y-3" key="answer-question-form">
          <div>
            <label className="text-sm font-medium text-foreground mb-2 block">
              {fetchingQuestion && (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground mr-2">
                  <Spinner variant="circle" className="h-3 w-3" />
                </span>
              )}
              {question.text}
            </label>
            <Textarea
              name="answer"
              onInput={(e) => {
                setCharCount(e.currentTarget.value.length);
                setError(null);
              }}
              disabled={loading}
              className={`min-h-24 transition-all ${
                error
                  ? 'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20'
                  : ''
              }`}
              placeholder="Enter your answer..."
              maxLength={5000}
            />
            <div className="flex items-center justify-between mt-1">
              {error && <p className="text-sm text-destructive">{error}</p>}
              <p
                className={`text-xs ml-auto ${charCount > 5000 ? 'text-destructive' : 'text-muted-foreground'}`}
              >
                {charCount}/5000
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={loading} size="sm">
              {loading ? (
                <Spinner variant="circle" className="h-4 w-4 mr-2" />
              ) : (
                <Send className="h-4 w-4 mr-2" />
              )}
              Submit Answer
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={handleDismiss} disabled={loading}>
              Skip
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}
