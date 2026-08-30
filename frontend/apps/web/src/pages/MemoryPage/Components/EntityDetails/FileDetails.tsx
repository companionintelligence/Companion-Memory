import { useMutation } from '@apollo/client';

import { FILE_FRAGMENT } from '@/components/entities/grid/FileGridItem';
import { resolveFileTileUrl, resolveMediaUrl } from '@/components/entities/resolveMediaUrl';
import { gql, useFragment } from '@/graphql';

import type { MemoryEntityOf } from '../../useEntityService';

import { DocumentFileActions, formatBytes } from './DocumentFileActions';
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

interface Props {
  entity: MemoryEntityOf<'FileType'>;
}

export function FileDetails({ entity }: Props) {
  const data = useFragment(FILE_FRAGMENT, entity);
  const [updateFile] = useMutation(UPDATE_FILE);

  const isVideo = data.contentType?.startsWith('video/') ?? false;
  // Video playback needs the original; images prefer preview then source (same
  // fallback as gallery tiles so Capture screenshots show before preview gen).
  const mediaSrc = isVideo
    ? resolveMediaUrl(data.sourceUrl)
    : resolveFileTileUrl({
        contentType: data.contentType,
        previewUrl: data.previewUrl,
        sourceUrl: data.sourceUrl,
      });
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
      {downloadUrl && <DocumentFileActions href={downloadUrl} filename={data.filename} download />}
    </EntityDetailScaffold>
  );
}
