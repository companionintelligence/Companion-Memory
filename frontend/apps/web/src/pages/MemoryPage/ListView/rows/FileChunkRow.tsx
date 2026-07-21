import { type MouseEvent, type ReactNode } from 'react';

import { FileText } from '@ci/shadcn/icons';

import { gql, useFragment, type FragmentType } from '@/graphql';

import { getFileChunkPreview, getFileChunkSubtitle, getFileChunkTitle } from '../../fileChunks';

import { EntityRow } from './EntityRow';

export const FILE_CHUNK_ROW_FRAGMENT = gql(`
  fragment TableFileChunkRowData on FileChunkType {
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
  fileChunk: FragmentType<typeof FILE_CHUNK_ROW_FRAGMENT>;
  time?: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function FileChunkRow({ fileChunk, time, onClick }: Props) {
  const data = useFragment(FILE_CHUNK_ROW_FRAGMENT, fileChunk);
  const title = getFileChunkTitle(data);
  const subtitle = getFileChunkSubtitle(data);
  const preview = getFileChunkPreview(data.chunkContent, 260);

  return (
    <EntityRow
      icon={
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <FileText className="h-4 w-4" />
        </div>
      }
      title={title}
      subtitle={
        <>
          {subtitle && <span>{subtitle}</span>}
          {preview && (
            <span className="line-clamp-2 pl-0 text-muted-foreground/70">
              {subtitle ? ` · ${preview}` : preview}
            </span>
          )}
        </>
      }
      time={time}
      onClick={onClick}
    />
  );
}
