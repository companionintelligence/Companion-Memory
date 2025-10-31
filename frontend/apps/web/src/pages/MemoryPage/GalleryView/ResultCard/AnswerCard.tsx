import { useEffect, useState, useCallback } from 'react';

import { Card, Badge } from '@ci/shadcn';
import { Hash } from '@ci/shadcn/icons';

import { useAuth } from '@/hooks';
import { formatPath, truncateText } from '@/pages/MemoryPage/ListView/utils.tsx';
import type { SearchResult } from '@/pages/MemoryPage/types.ts';

export interface Props {
  result: SearchResult;
}

export function AnswerCard({ result }: Props) {
  const [{ authToken }] = useAuth();

  const [answer, setAnswer] = useState<{
    [key: string]: unknown;
    question: { [key: string]: unknown };
  } | null>(null);

  const hydrateAnswer = useCallback(async () => {
    const answerResult = await (
      await fetch(`/api/answers/${result.id as string}`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      })
    ).json();
    setAnswer(answerResult);
  }, [result]);

  useEffect(() => {
    hydrateAnswer();
  }, [result]);

  return (
    <Card className="group hover:shadow-lg transition-shadow duration-200 overflow-hidden">
      <Card.Header className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <Badge
            variant="secondary"
            className={`bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200 flex items-center gap-1`}
          >
            <Hash className="h-4 w-4" />
            <span className="capitalize">{result.type}</span>
          </Badge>
          <code className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
            {result.id.substring(0, 8)}...
          </code>
        </div>

        {result.path && (
          <div className="text-xs text-muted-foreground font-mono">{formatPath(result.path)}</div>
        )}
      </Card.Header>

      <Card.Content>
        {answer?.answer != null && (
          <p className="text-sm text-muted-foreground line-clamp-4">
            {truncateText(answer?.answer as string, 200)}
          </p>
        )}
      </Card.Content>

      {answer?.question?.text != null && (
        <Card.Content>
          <p className="text-md line-clamp-4">Related Question</p>
          <p className="text-sm text-muted-foreground line-clamp-4">
            {truncateText(answer.question.text as string, 200)}
          </p>
        </Card.Content>
      )}
    </Card>
  );
}
