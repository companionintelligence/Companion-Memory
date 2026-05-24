import { type MouseEvent, useMemo } from 'react';

import { gql, useFragment, type FragmentType } from '@/graphql';

import { SearchTable } from '../SearchTable';

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
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function FileRow({ file, onClick }: Props) {
  const data = useFragment(FILE_FRAGMENT, file);

  const url = useMemo(() => {
    return data.previewUrl ? `/static${data.previewUrl}` : undefined;
  }, [data.previewUrl]);

  return (
    <SearchTable.Row onClick={onClick}>
      <SearchTable.Cell className="align-middle w-15 px-2.5">
        <img src={url} alt={data.filename || ''} className="h-6 w-6 rounded object-cover bg-muted" />
      </SearchTable.Cell>

      <SearchTable.Cell className="align-middle w-100">{data.title}</SearchTable.Cell>

      <SearchTable.Cell className="align-middle">
        {data.filename} <span className="text-muted-foreground pl-2">{data.contentType}</span>
      </SearchTable.Cell>
    </SearchTable.Row>
  );
}
