import { Button, Dialog } from '@ci/shadcn';

import { type FragmentType, useFragment } from '@/graphql';
import { FILE_CHUNK_CARD_FRAGMENT } from '@/pages/MemoryPage/Components/EntityCard/FileChunkCard';
import { getFileChunkPreview, getFileChunkSubtitle, getFileChunkTitle } from '@/pages/MemoryPage/fileChunks';

interface Props {
  entity: FragmentType<typeof FILE_CHUNK_CARD_FRAGMENT> | null;
  onClose: () => void;
}

export function FileChunkModal({ entity, onClose }: Props) {
  const data = useFragment(FILE_CHUNK_CARD_FRAGMENT, entity);

  if (!data) {
    return null;
  }

  const title = getFileChunkTitle(data);
  const subtitle = getFileChunkSubtitle(data);
  const sourceUrl = data.file?.sourceUrl ? `/static${data.file.sourceUrl}` : null;

  return (
    <Dialog open={entity != null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content className="sm:max-w-3xl max-h-[90vh] overflow-hidden p-0 gap-0">
        <Dialog.Header className="border-b px-6 py-4">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>{subtitle ?? 'Document excerpt'}</Dialog.Description>
        </Dialog.Header>

        <div className="space-y-6 overflow-y-auto px-6 py-5">
          {data.file?.filename && (
            <section className="space-y-1">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">File</div>
              <div className="text-sm">{data.file.filename}</div>
            </section>
          )}

          {data.createdAt && (
            <section className="space-y-1">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Indexed at
              </div>
              <div className="text-sm">{new Date(data.createdAt).toLocaleString()}</div>
            </section>
          )}

          <section className="space-y-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Excerpt</div>
            <div className="rounded-md border bg-muted/40 p-4 text-sm whitespace-pre-wrap leading-relaxed">
              {getFileChunkPreview(data.chunkContent, data.chunkContent.length)}
            </div>
          </section>
        </div>

        {sourceUrl && (
          <Dialog.Footer className="border-t px-6 py-4">
            <Button type="button" variant="outline" onClick={() => window.open(sourceUrl, '_blank')}>
              Open File
            </Button>
          </Dialog.Footer>
        )}
      </Dialog.Content>
    </Dialog>
  );
}
