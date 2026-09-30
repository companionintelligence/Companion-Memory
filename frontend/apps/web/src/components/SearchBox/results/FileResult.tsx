import { useMemo } from 'react';

import { gql, useFragment, type FragmentType } from '@/graphql';

import { SearchResultRow } from './SearchResultRow';

export const FILE_FRAGMENT = gql(`
  fragment SearchResultFileData on FileType {
    id
    filename
    previewUrl
  }
`);

interface Props {
  file: FragmentType<typeof FILE_FRAGMENT>;
}

export function FileResult({ file }: Props) {
  const data = useFragment(FILE_FRAGMENT, file);

  const url = useMemo(() => {
    return data.previewUrl ? `/static${data.previewUrl}` : undefined;
  }, [data.previewUrl]);

  return (
    <SearchResultRow
      icon={<img src={url} alt={data.filename || ''} className="h-6 w-6" />}
      title={data.filename}
      kind="File"
    />
  );
}
