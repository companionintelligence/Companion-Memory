import { ANSWER_FRAGMENT } from '@/components/entities/grid/AnswerGridItem';
import { useFragment } from '@/graphql';

import type { MemoryEntityOf } from '../../useEntityService';

import { EntityDetailScaffold } from './EntityDetailScaffold';

interface Props {
  entity: MemoryEntityOf<'AnswerType'>;
}

export function AnswerDetails({ entity }: Props) {
  const data = useFragment(ANSWER_FRAGMENT, entity);
  const question = data.question?.text?.trim() || null;
  const answer = data.answer?.trim() || null;

  return (
    <EntityDetailScaffold
      entity={entity}
      title={question || 'Answer'}
      subtitle="Answer"
      taggable
      editFields={[
        { key: 'question', label: 'Question', value: question ?? '' },
        { key: 'answer', label: 'Answer', value: answer ?? '', multiline: true },
      ]}
      metaItems={[{ label: 'Type', value: 'Answer' }]}
    />
  );
}
