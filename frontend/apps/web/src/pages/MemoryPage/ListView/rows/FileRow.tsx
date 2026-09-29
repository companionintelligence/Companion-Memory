import { type MouseEvent, type ReactNode, useMemo } from 'react';

import { resolveFileTileUrl } from '@/components/entities/resolveMediaUrl';
import { FileIcon } from '@/components/icons';
import { PendingImage } from '@/components/PendingImage';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityRow } from './EntityRow';

export const FILE_FRAGMENT = gql(`
  fragment TableFileRowData on FileType {
    id
    filename
    title
    previewUrl
    sourceUrl
    contentType
  }
`);

interface Props {
  file: FragmentType<typeof FILE_FRAGMENT>;
  time?: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function FileRow({ file, time, onClick }: Props) {
  const data = useFragment(FILE_FRAGMENT, file);

  const url = useMemo(
    () =>
      resolveFileTileUrl({
        contentType: data.contentType,
        previewUrl: data.previewUrl,
        sourceUrl: data.sourceUrl,
      }),
    [data.contentType, data.previewUrl, data.sourceUrl],
  );

  return (
    <EntityRow
      icon={
        url ? (
          <PendingImage src={url} />
        ) : (
          <FileIcon />
        )
      }
      title={data.title}
      subtitle={
        <>
          {data.filename}
          {data.contentType && <span className="pl-2 text-muted-foreground/70">{data.contentType}</span>}
        </>
      }
      time={time}
      onClick={onClick}
    />
  );
}
