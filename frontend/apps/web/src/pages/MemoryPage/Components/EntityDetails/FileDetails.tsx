import { useMutation } from '@apollo/client';
import { Download } from '@ci/shadcn/icons';

import { FILE_FRAGMENT } from '@/components/entities/grid/FileGridItem';
import { gql, useFragment } from '@/graphql';

import type { MemoryEntityOf } from '../../useEntityService';

import { EntityDetailScaffold, EntityMedia, resolveStaticUrl } from './EntityDetailScaffold';

// `updateFile` decodes the GlobalUID server-side, so pass the encoded id.
const UPDATE_FILE = gql(`
  mutation UpdateFileDetail($input: UpdateFileInput!) {
    updateFile(input: $input) {
      id
      title
      description
    }
  }
`);

function formatBytes(bytes?: number | null): string | null {
  if (bytes == null) {
    return null;
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(1)} ${units[unit]}`;
}

interface Props {
  entity: MemoryEntityOf<'FileType'>;
}

export function FileDetails({ entity }: Props) {
  const data = useFragment(FILE_FRAGMENT, entity);
  const [updateFile] = useMutation(UPDATE_FILE);

  const isVideo = data.contentType?.startsWith('video/') ?? false;
  const mediaSrc = resolveStaticUrl(isVideo ? data.sourceUrl : (data.previewUrl ?? data.sourceUrl));
  const downloadUrl = resolveStaticUrl(data.sourceUrl);

  return (
    <EntityDetailScaffold
      entity={entity}
      title={data.title || data.filename || 'File'}
      subtitle="File"
      taggable
      media={<EntityMedia src={mediaSrc} contentType={data.contentType} alt={data.filename ?? ''} />}
      editFields={[
        { key: 'title', label: 'Title', value: data.title ?? '' },
        { key: 'description', label: 'Description', value: data.description ?? '', multiline: true },
      ]}
      onSave={async (values) => {
        await updateFile({
          variables: { input: { id: entity.id, title: values.title, description: values.description } },
        });
      }}
      metaItems={[
        { label: 'Filename', value: data.filename },
        { label: 'Content type', value: data.contentType },
        { label: 'Size', value: formatBytes(data.size) },
        { label: 'Created', value: data.createdAt ? new Date(data.createdAt).toLocaleString() : null },
      ]}
      rawData={data}
    >
      {downloadUrl && (
        <a
          href={downloadUrl}
          download={data.filename ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
        >
          <Download className="size-4" /> Download
        </a>
      )}
    </EntityDetailScaffold>
  );
}
