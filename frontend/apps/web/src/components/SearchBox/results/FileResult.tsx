import { useMemo } from 'react';

import { gql, useFragment, type FragmentType } from '@/graphql';

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

  console.log('FileResult data:', data);

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <img src={url} alt={data.filename || ''} className="w-6 h-6" />
        <div className="font-medium">{data.filename}</div>
      </div>
      <div className="text-muted-foreground">File</div>
    </div>
  );
}
