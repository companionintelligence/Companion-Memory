import { useCallback, useRef, useState, type FormEvent } from 'react';

import { Camera } from '@ci/capture';
import { Dialog } from '@ci/shadcn';
import { Send } from '@ci/shadcn/icons';

import type { File as CIFile } from '@/api/types.ts';
import { Chat, type FormData } from '@/components/Chat';
import { useAuth, useChatRequester, useModel } from '@/hooks';
import { getMediaType } from '@/lib/utils';

interface Props {
  open?: boolean;
  initialFiles?: CIFile[];
  onClose?: () => void;
}

export function CaptureModal({ open = false, initialFiles = [], onClose }: Props) {
  const [files, setFiles] = useState<CIFile[]>(initialFiles);
  const threadId = useRef<string | null>(null);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setFiles([]);
      onClose?.();
    }
  }, []);

  const [{ selectedModel }] = useModel();
  const [{ authToken }] = useAuth();

  const [{ stream, loading, streaming }, { submit: submitChatRequest, stop: stopChatRequest }] =
    useChatRequester({
      threadId: threadId.current,
      enableTools: false,
      enableThinking: false,
    });

  const handleSubmit = useCallback(
    async (data: FormData, e?: FormEvent) => {
      e?.preventDefault();

      return submitChatRequest(data);
    },
    [submitChatRequest],
  );

  const handleMediaCaptured = useCallback(
    async (file: File) => {
      const formData = new FormData();

      formData.append('file', file);

      const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
        body: formData,
      });

      const resJson = await res.json();

      if (!res.ok) {
        console.error('Upload failed', resJson);
      }

      const threadRes = await fetch('/api/threads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          files: [
            {
              id: resJson.id,
            },
          ],
          model: selectedModel,
        }),
      });

      const threadResJson = await threadRes.json();

      if (!threadRes.ok) {
        console.error('Linking file to thread failed', threadResJson);
      }

      threadId.current = threadResJson.id;

      setFiles(
        files.concat({
          url: URL.createObjectURL(file),
          ...resJson,
        }),
      );
    },
    [authToken, selectedModel],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Dialog.Content className="sm:max-w-[70vw] max-h-[70vh] p-0 flex flex-col gap-0">
        <Dialog.Header className="flex flex-row items-center gap-4 p-4 pb-3 border-b bg-stone-50 rounded-t-2xl">
          <Dialog.Title>Upload Images and Videos</Dialog.Title>
          <Dialog.Description className="hidden">Capture audio or video and upload to CI</Dialog.Description>
        </Dialog.Header>

        {files.length === 0 && (
          <Camera onFrameCaptured={handleMediaCaptured} onRecordingFinished={handleMediaCaptured}>
            <div>
              <Camera.Feed />
            </div>
          </Camera>
        )}
        {files.length > 0 && (
          <div className="flex flex-1 max-h-100">
            {/* Left side: file preview or fallback */}
            <div className="flex flex-col gap-4 p-4 border-r min-w-[320px] max-w-[480px] w-full">
              {files.map((file) => {
                const fileType = getMediaType(file.contentType);
                switch (fileType) {
                  case 'video':
                    return (
                      <div className="aspect-video rounded-lg overflow-hidden bg-stone-100">
                        <video controls className="w-full h-full object-cover">
                          <source src={file.url} type={file.contentType} />
                          Your browser does not support the video tag.
                        </video>
                      </div>
                    );
                  case 'audio':
                    return (
                      <div className="rounded-lg overflow-hidden bg-stone-100 p-4 flex items-center justify-center">
                        <audio controls className="w-full">
                          <source src={file.url} type={file.contentType} />
                          Your browser does not support the audio element.
                        </audio>
                      </div>
                    );
                  case 'image':
                    return (
                      <div className="aspect-video rounded-lg overflow-hidden bg-stone-100">
                        <img src={file.url} className="w-full h-full object-cover" />
                      </div>
                    );
                }
              })}
            </div>

            {/* Right side: Chat */}
            {files?.length > 0 && (
              <div className="flex-1 min-w-0 max-h-100 overflow-y-auto">
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
            )}
          </div>
        )}
      </Dialog.Content>
    </Dialog>
  );
}
