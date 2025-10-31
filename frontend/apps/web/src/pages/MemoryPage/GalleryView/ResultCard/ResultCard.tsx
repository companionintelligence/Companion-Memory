import type { MemoryItem, SearchResult } from '../../types.ts';

import { AnswerCard } from './AnswerCard.tsx';
import { ContentCard } from './ContentCard.tsx';
import { EntityCard } from './EntityCard.tsx';
import { ImageCard } from './ImageCard.tsx';
import { QuestionCard } from './QuestionCard.tsx';

export interface Props {
  result: SearchResult | MemoryItem;
}

export function ResultCard({ result }: Props) {
  switch (result.type) {
    case 'answer':
      return <AnswerCard result={result} />;
    case 'question':
      return <QuestionCard result={result} />;
    case 'image':
    case 'photo':
      return <ImageCard result={result} />;
    case 'entity':
    case 'graph_node':
      return <EntityCard result={result} />;
    case 'content':
      return <ContentCard result={result as MemoryItem} />;
    default:
      return null;
  }
}
