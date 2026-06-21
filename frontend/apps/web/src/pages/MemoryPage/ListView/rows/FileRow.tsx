import { type MouseEvent, type ReactNode, useMemo } from 'react';

import { FileIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityRow } from './EntityRow';

export const FILE_FRAGMENT = gql(`
  fragment TableFileRowData on FileType {
    id
    filename
    title
    previewUrl
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

  const url = useMemo(() => {
    return data.previewUrl ? `/static${data.previewUrl}` : undefined;
  }, [data.previewUrl]);

  return (
    <EntityRow
      icon={
        url ? (
          <img src={url} alt={data.filename || ''} className="h-9 w-9 rounded-md bg-muted object-cover" />
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
