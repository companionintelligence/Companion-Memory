import { type FormEvent, useEffect, useMemo, useState } from 'react';

import { useDeviceLayout } from '@ci/common';
import { Button, Textarea, cn } from '@ci/shadcn';

import { type FeedQuestion } from './useFeedQuestionService';

interface Props {
  question: FeedQuestion;
  submitting: boolean;
  onSubmit: (input: { questionId: string; text: string }) => Promise<boolean>;
  className?: string;
}

export function QuestionCard({ question, submitting, onSubmit, className }: Props) {
  const { isMobile } = useDeviceLayout();

  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAnswer('');
    setError(null);
  }, [question.presentationId]);

  const containerClassName = useMemo(
    () =>
      isMobile
        ? 'h-full w-full flex flex-col border border-border bg-card text-card-foreground rounded-lg p-4 gap-4'
        : 'w-[550px] h-[400px] relative flex flex-col border border-border bg-card text-card-foreground shadow-md rounded-lg p-4 gap-4',
    [isMobile],
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmed = answer.trim();

    if (!trimmed) {
      setError('Please enter an answer before submitting.');

      return;
    }

    const success = await onSubmit({
      questionId: question.id,
      text: trimmed,
    });

    if (!success) {
      setError('Unable to submit your answer right now. Please try again.');

      return;
    }

    setError(null);
    setAnswer('');
  };

  return (
    <form className={cn(containerClassName, className)} onSubmit={handleSubmit}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-2xl font-semibold">Question</h3>
        {question.category && (
          <span className="text-xs text-muted-foreground uppercase">{question.category}</span>
        )}
      </div>

      <p className="text-base leading-relaxed text-foreground">{question.text}</p>

      <div className="flex-1 min-h-0">
        <Textarea
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          placeholder="Share your answer..."
          className="h-full min-h-30 resize-none"
          disabled={submitting}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-destructive">{error ?? ''}</span>
        <Button type="submit" disabled={submitting || answer.trim().length === 0}>
          {submitting ? 'Submitting...' : 'Submit answer'}
        </Button>
      </div>
    </form>
  );
}
