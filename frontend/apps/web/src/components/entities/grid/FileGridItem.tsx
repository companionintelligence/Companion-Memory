import { type MouseEvent, useMemo } from 'react';

import { FileIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { EntityGridItem } from './EntityGridItem';

export const FILE_FRAGMENT = gql(`
  fragment FileGridItemData on FileType {
    id
    filename
    previewUrl
  }
`);

interface Props {
  file: FragmentType<typeof FILE_FRAGMENT>;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function FileGridItem({ file, onClick }: Props) {
  const data = useFragment(FILE_FRAGMENT, file);

  const url = useMemo(() => {
    return data.previewUrl ? `/static${data.previewUrl}` : undefined;
  }, [data.previewUrl]);

  return (
    <EntityGridItem className="relative p-0" onClick={onClick}>
      <div className="rounded-md overflow-hidden min-h-0 grow inset-0">
        {url && <img src={url} alt={data.filename || ''} className="w-full h-full object-cover" />}

        {!url && (
          <>
            <div className="absolute p-2 px-3 bottom-0 w-full text-sm truncate text-muted-foreground">
              {data.filename}
            </div>

            <div className="flex flex-col items-center justify-center w-full h-full gap-2 p-4">
              <FileIcon className="h-10 w-10 text-muted-foreground" />
            </div>
          </>
        )}
      </div>
    </EntityGridItem>
  );
}
