import { Card } from '@ci/shadcn';
import { FileText } from '@ci/shadcn/icons';

import { gql, useFragment, type FragmentType } from '@/graphql';

import { getFileChunkPreview, getFileChunkSubtitle, getFileChunkTitle } from '../../fileChunks';
import { useEntityService } from '../../useEntityService';

interface Props {
  entity: FragmentType<typeof FILE_CHUNK_CARD_FRAGMENT>;
}

export const FILE_CHUNK_CARD_FRAGMENT = gql(`
  fragment TimelineFileChunkCardData on FileChunkType {
    id
    sectionTitle
    chunkContent: content
    sourceLocator
    createdAt
    file {
      id
      filename
      sourceUrl
    }
  }
`);

export function FileChunkCard({ entity }: Props) {
  const [, { setActiveEntity }] = useEntityService();
  const data = useFragment(FILE_CHUNK_CARD_FRAGMENT, entity);
  const title = getFileChunkTitle(data);
  const subtitle = getFileChunkSubtitle(data);

  return (
    <Card
      className="!gap-2 !py-4 px-6 cursor-pointer hover:shadow-lg transition-shadow duration-200"
      onClick={() => setActiveEntity({ ...data, __typename: 'FileChunkType' })}
    >
      <div className="flex items-start gap-3">
        <FileText className="h-6 w-6 flex-shrink-0 mt-1 text-[var(--primary)]" />
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-semibold text-card-foreground truncate">{title}</h3>
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </div>
      </div>

      <div className="pt-3 pb-3">
        <p className="text-sm text-muted-foreground leading-relaxed">
          {getFileChunkPreview(data.chunkContent, 420)}
        </p>
      </div>
    </Card>
  );
}
