import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { Camera } from '@ci/capture';
import { fetchJson, useDeviceLayout } from '@ci/common';
import { Dialog, cn, Button } from '@ci/shadcn';
import { Send, X } from '@ci/shadcn/icons';

import { useUploadFile } from '@/api';
import type { File as FileData, Thread } from '@/api/types';
import { Chat, type FormData } from '@/components/Chat';
import { InlineModal } from '@/components/InlineModal';
import { useAuth, useChatRequester, useModel } from '@/hooks';
import { getMediaType } from '@/lib/utils';

interface Props {
  open?: boolean;
  initialFiles?: FileData[];
  onClose?: () => void;
}

export function CaptureModal({ open = false, initialFiles = [], onClose }: Props) {
  const [{ authToken }] = useAuth();
  const [{ selectedModel }] = useModel();

  const { isMobile } = useDeviceLayout();

  const [files, setFiles] = useState<FileData[]>(initialFiles);
  const [threadId, setThreadId] = useState<string | null>(null);

  const [{ file: fileData }, { upload }] = useUploadFile();

  const [{ stream, loading, streaming }, { submit: submitChatRequest, stop: stopChatRequest }] =
    useChatRequester({
      threadId,
      enableTools: false,
      enableThinking: false,
    });

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setFiles([]);
        onClose?.();
      }
    },
    [onClose],
  );

  const handleMediaCaptured = useCallback(
    async (file: File) => {
      upload(file);
    },
    [upload],
  );

  const createFileThread = useCallback(
    async (fileId: string) => {
      const thread = await fetchJson<Thread>('/api/threads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          files: [
            {
              id: fileId,
            },
          ],
          model: selectedModel,
        }),
      });

      setThreadId(thread.id);
    },
    [authToken, selectedModel],
  );

  useEffect(() => {
    (async () => {
      if (fileData == null) {
        return;
      }

      // We do this with an additional user interaction on mobile, so skip here
      if (isMobile) {
        return;
      }

      await createFileThread(fileData.id);

      setFiles((current) => [...current, fileData]);
    })();
  }, [fileData]);

  const handleSelectLastCapture = useCallback(async () => {
    if (fileData == null) {
      return;
    }

    await createFileThread(fileData.id);

    setFiles((current) => [...current, fileData]);
  }, [fileData, createFileThread]);

  const handleSubmit = useCallback(
    async (data: FormData, e?: FormEvent) => {
      e?.preventDefault();

      return submitChatRequest(data);
    },
    [submitChatRequest],
  );

  if (isMobile) {
    if (files.length === 0) {
      return (
        <InlineModal open={open} onClose={onClose} className="fixed">
          <div className="absolute top-[env(safe-area-inset-top)] right-0 z-10">
            <div className="flex-1 text-right text-white">
              <Button variant="ghost" size="icon" onClick={onClose}>
                <X />
              </Button>
            </div>
          </div>

          <Camera
            onFrameCaptured={handleMediaCaptured}
            onRecordingFinished={handleMediaCaptured}
            className="h-full"
          >
            <Camera.Feed />
            <div className="absolute w-full bottom-0">
              <Camera.MobileControls onSelectLastCapture={handleSelectLastCapture} />
            </div>
          </Camera>
        </InlineModal>
      );
    }

    return (
      <InlineModal open={open} onClose={onClose}>
        <div className="flex flex-row items-center justify-between border-b bg-stone-50 dark:bg-secondary gap-2 p-2 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="flex-1" />
          <div className="text-xl font-bold text-transparent">{files[0].name}</div>
          <div className="flex-1 text-right">
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X />
            </Button>
          </div>
        </div>

        <Chat
          placeholder="Ask about this content..."
          streaming={streaming}
          readable={stream ?? undefined}
          onSubmit={submitChatRequest}
          onStop={stopChatRequest}
        >
          <Files files={files} />
        </Chat>
      </InlineModal>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Dialog.Content
        className={cn(
          'w-[90vw] h-[90vh] sm:max-w-[90vw] sm:max-h-[80vh] p-0 flex flex-col gap-0',
          files.length > 0 && 'max-[900px]:h-[80vh]',
        )}
      >
        <Dialog.Header className="flex flex-row items-center gap-4 p-4 pb-3 border-b bg-stone-50 rounded-t-2xl">
          <Dialog.Title>Upload Images and Videos</Dialog.Title>
          <Dialog.Description className="hidden">Capture audio or video and upload to CI</Dialog.Description>
        </Dialog.Header>

        {files.length === 0 && (
          <Camera
            onFrameCaptured={handleMediaCaptured}
            onRecordingFinished={handleMediaCaptured}
            className="h-full"
          >
            <Camera.Information />
            <Camera.Feed />
            <Camera.DesktopControls />
          </Camera>
        )}

        {files.length > 0 && (
          <div className="flex flex-col flex-1 min-[900px]:flex-row min-h-0 min-w-0">
            {/* Left side: file preview or fallback */}
            <div className="flex max-[900px]:max-h-1/2">
              <div className="flex flex-col gap-4 p-2 min-[900px]:border-r max-w-[480px] w-full overflow-y-auto m-auto h-full min-h-0">
                <Files files={files} />
              </div>
            </div>

            <div className="flex-1 margin-4 min-w-0 max-[900px]:max-h-1/2 max-[900px]:border-t max-[900px]:pt-1">
              <Chat
                loading={loading}
                streaming={streaming}
                readable={stream ?? undefined}
                onSubmit={handleSubmit}
                onStop={stopChatRequest}
                placeholder="Ask about this content..."
                emptyState={
                  <div className="text-center text-gray-500 mt-8">
                    <div className="w-16 h-16 mx-auto mb-4 bg-stone-100 rounded-full flex items-center justify-center">
                      <Send className="w-8 h-8 text-zinc-400 relative top-0.5 -left-0.5" />
                    </div>
                    <p className="text-sm">Start a conversation about this content</p>
                    <p className="text-xs text-gray-400 mt-1">
                      Ask questions, get recommendations, or explore ideas
                    </p>
                  </div>
                }
              />
            </div>
          </div>
        )}
      </Dialog.Content>
    </Dialog>
  );
}

function Files({ files }: { files?: FileData[] | null }) {
  if (files == null) {
    return null;
  }

  return (
    <>
      {files.map((file) => {
        const fileType = getMediaType(file.contentType);

        switch (fileType) {
          case 'video':
            return (
              <div className="aspect-video rounded-lg overflow-hidden bg-stone-100">
                <video controls className="w-full h-full object-cover">
                  <source src={`/static${file.url}`} type={file.contentType} />
                  Your browser does not support the video tag.
                </video>
              </div>
            );
          case 'audio':
            return (
              <div className="rounded-lg overflow-hidden bg-stone-100 p-4 flex items-center justify-center">
                <audio controls className="w-full">
                  <source src={`/static${file.url}`} type={file.contentType} />
                  Your browser does not support the audio element.
                </audio>
              </div>
            );
          case 'image':
            return (
              <div className="rounded-lg bg-stone-100">
                <img src={`/static${file.url}`} className="w-full h-full object-cover" />
              </div>
            );
        }
      })}
    </>
  );
}
