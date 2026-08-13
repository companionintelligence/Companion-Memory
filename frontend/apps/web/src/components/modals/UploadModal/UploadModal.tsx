import { useCallback, useState, type FormEvent } from 'react';

import { Badge, Button, Dialog, IconButton, Spinner } from '@ci/shadcn';
import { FilePlus, Scan, X } from '@ci/shadcn/icons';
import { useDropzone } from 'react-dropzone';
import { useTranslation } from 'react-i18next';

interface Props {
  open?: boolean;
  onSubmit?: (files: FileList) => Promise<boolean | void> | boolean | void;
  onClose?: (open?: boolean) => void;
}

export function UploadModal({ open, onClose, onSubmit }: Props) {
  const { t } = useTranslation();
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    setFiles((prev) => {
      const existingNames = new Set(prev.map((f) => f.name));
      const newFiles = acceptedFiles.filter((file) => !existingNames.has(file.name));

      return [...prev, ...newFiles];
    });
  }, []);

  const removeFile = useCallback((fileName: string) => {
    setFiles((prev) => prev.filter((f) => f.name !== fileName));
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: true,
  });

  const DropIcon = isDragActive ? Scan : FilePlus;
  const dropText = isDragActive ? 'Drop files here' : 'Drag or click to upload';

  const handleClose = useCallback(() => {
    if (loading) {
      return;
    }

    setFiles([]);
    onClose?.(false);
  }, [loading, onClose]);

  const handleUpload = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();

      setLoading(true);

      const dataTransfer = new DataTransfer();

      files.forEach((file) => {
        dataTransfer.items.add(file);
      });

      try {
        const result = await onSubmit?.(dataTransfer.files);

        if (result === true) {
          handleClose();
        }
      } finally {
        setLoading(false);
      }
    },
    [files, onClose, onSubmit],
  );

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <Dialog.Content className="p-0 flex flex-col gap-0" showCloseButton={false}>
        <Dialog.Header className="flex flex-row items-center justify-between border-b bg-stone-50 dark:bg-secondary rounded-t-lg gap-2 p-2 pl-4">
          <Dialog.Title>Upload files</Dialog.Title>
          <Dialog.Description className="hidden">Upload files to your Companion Memory.</Dialog.Description>

          <div className="flex items-center justify-end">
            <IconButton label={t('COMMON_CLOSE')} variant="ghost" size="icon" onClick={handleClose}>
              <X />
            </IconButton>
          </div>
        </Dialog.Header>

        <form onSubmit={handleUpload} encType="multipart/form-data" className="flex flex-col gap-4 p-4">
          <div
            {...getRootProps()}
            className="flex flex-col items-center justify-center h-40 border-8 p-2 rounded-lg gap-2 cursor-pointer select-none"
          >
            <input {...getInputProps()} />

            <DropIcon className="h-8 w-8 text-muted-foreground" strokeWidth={1.5} />

            <div>{dropText}</div>
          </div>

          {files.length > 0 && (
            <div className="inline-flex gap-2 flex-wrap">
              {files.map((f) => (
                <Badge
                  key={f.name}
                  className="max-w-32 flex flex-row justify-between items-center p-1 pl-2 gap-1"
                >
                  <div className="truncate">{f.name}</div>
                  <IconButton
                    label={t('UPLOAD_REMOVE_FILE', { name: f.name })}
                    variant="ghost"
                    size="icon"
                    className="h-4 w-4 p-1 hover:bg-primary! hover:text-primary-foreground!"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFile(f.name);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </IconButton>
                </Badge>
              ))}
            </div>
          )}

          <Dialog.Footer>
            <Button type="button" variant="secondary" onClick={handleClose}>
              Close
            </Button>
            <Button type="submit" disabled={files.length === 0 || loading}>
              {loading ? <Spinner variant="circle" /> : null}
              Upload
            </Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog>
  );
}
