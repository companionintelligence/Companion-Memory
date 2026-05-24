import { useMemo } from 'react';

import { useQuery } from '@apollo/client';
import { Button, Dialog } from '@ci/shadcn';
import { Download, FileIcon, Loader2, X } from '@ci/shadcn/icons';

import { gql } from '@/graphql';

const GET_FILE_PREVIEW = gql(`
  query GetFilePreview($id: ID!) {
    file(id: $id) {
      id
      filename
      contentType
      sourceUrl
      previewUrl
      createdAt
    }
  }
`);

export function FileModal({ fileId, onClose }: { fileId: string | null; onClose: () => void }) {
  const { data, loading } = useQuery(GET_FILE_PREVIEW, {
    variables: { id: fileId! },
    skip: fileId == null,
    fetchPolicy: 'cache-first',
  });

  const file = data?.file ?? null;

  const sourceUrl = useMemo(() => {
    return file?.sourceUrl ? `/static${file.sourceUrl}` : undefined;
  }, [file?.sourceUrl]);

  const isVideo = file?.contentType.startsWith('video/') ?? false;
  const isImage = file?.contentType.startsWith('image/') ?? false;

  return (
    <Dialog open={fileId != null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content
        showCloseButton={false}
        className="w-fit max-w-[95vw] sm:max-w-[95vw] p-0 gap-0 overflow-hidden border-none rounded-xl shadow-2xl"
      >
        <Dialog.Header className="flex flex-row items-center justify-end border-b bg-stone-50 dark:bg-secondary rounded-t-xl gap-2 p-2 pl-4">
          {sourceUrl && (
            <a
              href={sourceUrl}
              download={file?.filename ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button variant="ghost" size="icon" aria-label="Download file">
                <Download />
              </Button>
            </a>
          )}
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X />
          </Button>
        </Dialog.Header>

        <div className="flex items-center justify-center max-h-[85vh]">
          {loading ? (
            <div className="flex items-center justify-center min-h-[40vh]">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : sourceUrl ? (
            <>
              {isVideo && <video src={sourceUrl} className="max-w-full max-h-[85vh]" controls />}
              {isImage && (
                <img
                  src={sourceUrl}
                  alt={file?.filename || ''}
                  className="max-w-full max-h-[85vh] object-contain"
                />
              )}
              {!isVideo && !isImage && (
                <div className="flex flex-col items-center justify-center w-full aspect-square gap-2 p-4">
                  <FileIcon className="h-10 w-10 text-muted-foreground" />
                </div>
              )}
            </>
          ) : (
            <div className="text-sm text-muted-foreground p-8">No image source available.</div>
          )}
        </div>

        <div className="bg-background border-t border-border px-4 py-3 space-y-2 rounded-b-xl">
          <Metadatum label="Filename" value={file?.filename ?? 'Untitled'} />
          <Metadatum label="Content type" value={file?.contentType ?? 'Unknown'} />
          <Metadatum label="Created" value={file ? formatDateTime(file.createdAt) : 'Unknown'} />
        </div>
      </Dialog.Content>
    </Dialog>
  );
}

function Metadatum({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-xs uppercase tracking-wide text-muted-foreground shrink-0">{label}</span>
      <span className="text-sm break-words">{value}</span>
    </div>
  );
}

function formatDateTime(value: string | Date): string {
  return new Date(value).toLocaleString();
}
