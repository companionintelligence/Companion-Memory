import { useState } from 'react';

import { shareNativeTextFile } from '@ci/common';
import { Button, Dialog } from '@ci/shadcn';
import { Download } from '@ci/shadcn/icons';

import {
  buildConversationExport,
  type ConversationExportFormat,
  type ExportMessage,
} from './conversationExportFormat';

export function ConversationExport({
  title,
  messages,
  disabled,
}: {
  title: string;
  messages: ExportMessage[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleExport = async (format: ConversationExportFormat) => {
    setBusy(true);
    setError(null);

    try {
      const file = buildConversationExport(title, messages, format);
      if (!(await shareNativeTextFile(file))) {
        const url = URL.createObjectURL(new Blob([file.content], { type: `${file.mimeType};charset=utf-8` }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = file.filename;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        // Keep it alive through the download hand-off on Safari.
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }

      setOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not export this conversation. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="min-h-11"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Download className="h-4 w-4" /> Export chat
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Export conversation</Dialog.Title>
            <Dialog.Description>
              Save the conversation currently open on this device, including memory sources. Hidden reasoning
              and tool output are omitted from text exports.
            </Dialog.Description>
          </Dialog.Header>
          <div className="flex flex-wrap gap-2">
            {(['txt', 'md', 'json'] as const).map((format) => (
              <Button
                type="button"
                key={format}
                variant="outline"
                className="min-h-11"
                disabled={busy}
                onClick={() => void handleExport(format)}
              >
                {format === 'txt' ? 'Text (.txt)' : format === 'md' ? 'Markdown (.md)' : 'JSON (.json)'}
              </Button>
            ))}
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </Dialog.Content>
      </Dialog>
    </>
  );
}
