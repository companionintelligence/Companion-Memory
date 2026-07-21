import { type MouseEvent } from 'react';

import { FileText } from '@ci/shadcn/icons';

import { gql, useFragment, type FragmentType } from '@/graphql';
import { getFileChunkPreview, getFileChunkSubtitle, getFileChunkTitle } from '@/pages/MemoryPage/fileChunks';

import { EntityGridItem } from './EntityGridItem';

export const FILE_CHUNK_FRAGMENT = gql(`
  fragment FileChunkGridItemData on FileChunkType {
    id
    sectionTitle
    chunkContent: content
    sourceLocator
    file {
      id
      filename
    }
  }
`);

interface Props {
  fileChunk: FragmentType<typeof FILE_CHUNK_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function FileChunkGridItem({ fileChunk, onClick }: Props) {
  const data = useFragment(FILE_CHUNK_FRAGMENT, fileChunk);
  const title = getFileChunkTitle(data);
  const subtitle = getFileChunkSubtitle(data);

  return (
    <EntityGridItem onClick={onClick}>
      <EntityGridItem.Header>
        <FileText className="shrink-0" />
        <div className="text-md font-semibold truncate">{title}</div>
      </EntityGridItem.Header>

      <EntityGridItem.Content>
        {subtitle && <div className="text-sm text-muted-foreground">{subtitle}</div>}
        <div className="line-clamp-4 leading-tight">{getFileChunkPreview(data.chunkContent, 320)}</div>
      </EntityGridItem.Content>

      <EntityGridItem.Footer className="self-end">
        <div className="text-sm text-muted-foreground">Document excerpt</div>
      </EntityGridItem.Footer>
    </EntityGridItem>
  );
}
