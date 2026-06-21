import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { Camera } from '@ci/capture';
import { fetchJson, useDeviceLayout } from '@ci/common';
import { Dialog, cn, Button, Popover, useToast } from '@ci/shadcn';
import { Send, Settings, X } from '@ci/shadcn/icons';

import { useUploadFile } from '@/api';
import type { File as FileData, Thread } from '@/api/types';
import { Chat, type FormData } from '@/components/Chat';
import { InlineModal } from '@/components/InlineModal';
import { ModelSelector } from '@/components/ModelSelector';
import { useAuth, useChatRequester, useModel } from '@/hooks';
import { getMediaType } from '@/lib/utils';

interface Props {
  open?: boolean;
  onClose?: () => void;
}

type CaptureMode = 'photo' | 'video' | 'inventory';

interface ModelCapabilitiesResponse {
  vision: boolean;
}

export function CaptureModal({ open = false, onClose }: Props) {
  const [{ authToken }] = useAuth();
  const [{ selectedVisionModel: selectedModel }] = useModel();
  const { toast } = useToast();

  const { isMobile } = useDeviceLayout();

  const [files, setFiles] = useState<FileData[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [selectedModelSupportsVision, setSelectedModelSupportsVision] = useState<boolean | null>(null);
  const [isCheckingModelCapabilities, setIsCheckingModelCapabilities] = useState(false);
  const [capabilityCheckFailed, setCapabilityCheckFailed] = useState(false);
  const modelVisionSupportCacheRef = useRef<Map<string, boolean>>(new Map());

  const [{ files: fileData }, { upload, reset: resetUploader }] = useUploadFile();

  const [
    { stream, loading, streaming, hasStartedReceiving },
    { submit: submitChatRequest, stop: stopChatRequest },
  ] = useChatRequester({
    threadId,
  });

  const handleClose = useCallback(() => {
    setFiles([]);
    setThreadId(null);
    resetUploader();
    stopChatRequest();

    onClose?.();
  }, [onClose, resetUploader, stopChatRequest]);

  useEffect(() => {
    if (!open) {
      setFiles([]);
      setThreadId(null);
    }
  }, [open]);

  useEffect(() => {
    if (authToken == null || selectedModel == null) {
      setSelectedModelSupportsVision(null);
      setCapabilityCheckFailed(false);
      setIsCheckingModelCapabilities(false);

      return;
    }

    const cachedSupport = modelVisionSupportCacheRef.current.get(selectedModel);

    if (cachedSupport != null) {
      setSelectedModelSupportsVision(cachedSupport);
      setCapabilityCheckFailed(false);
      setIsCheckingModelCapabilities(false);

      return;
    }

    let canceled = false;

    setSelectedModelSupportsVision(null);
    setCapabilityCheckFailed(false);
    setIsCheckingModelCapabilities(true);

    (async () => {
      try {
        const query = new URLSearchParams({ model: selectedModel }).toString();

        const response = await fetchJson<ModelCapabilitiesResponse>(`/api/llm/models/capabilities?${query}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
        });

        if (canceled || !response) {
          return;
        }

        modelVisionSupportCacheRef.current.set(selectedModel, response.vision);
        setSelectedModelSupportsVision(response.vision);
      } catch {
        if (canceled) {
          return;
        }

        setCapabilityCheckFailed(true);
        setSelectedModelSupportsVision(false);
      } finally {
        if (!canceled) {
          setIsCheckingModelCapabilities(false);
        }
      }
    })();

    return () => {
      canceled = true;
    };
  }, [authToken, selectedModel]);

  const ensureImageModelSupported = useCallback((): boolean => {
    if (selectedModel == null) {
      toast.error('Select a model before capturing images.');

      return false;
    }

    if (capabilityCheckFailed) {
      toast.error('Unable to verify model image support right now. Try again.');

      return false;
    }

    if (isCheckingModelCapabilities || selectedModelSupportsVision == null) {
      toast.error('Checking selected model capabilities. Try again in a moment.');

      return false;
    }

    if (!selectedModelSupportsVision) {
      toast.error('Selected model does not support image input. Choose a vision model.');

      return false;
    }

    return true;
  }, [capabilityCheckFailed, isCheckingModelCapabilities, selectedModel, selectedModelSupportsVision, toast]);

  const handleCapturedMedia = useCallback(
    async (file: File, mode: CaptureMode) => {
      const isImage = file.type.startsWith('image/');

      if (isImage && !ensureImageModelSupported()) {
        return;
      }

      const inventoryCapture = isImage && mode === 'inventory';
      const uploaded = await upload([file], {
        inventoryCapture,
        model: selectedModel ?? undefined,
      });

      if (inventoryCapture && uploaded) {
        toast.success('Inventory analysis started. This may take a moment.');
      }
    },
    [ensureImageModelSupported, selectedModel, toast, upload],
  );

  const handleMobileFrameCaptured = useCallback(
    async (file: File, mode: CaptureMode) => {
      if (!ensureImageModelSupported()) {
        return;
      }

      const inventoryCapture = mode === 'inventory';
      const uploaded = await upload([file], {
        inventoryCapture,
        model: selectedModel ?? undefined,
      });

      if (inventoryCapture && uploaded) {
        toast.success('Inventory analysis started. This may take a moment.');
      }
    },
    [ensureImageModelSupported, selectedModel, toast, upload],
  );

  const createFileThread = useCallback(async () => {
    const thread = await fetchJson<Thread>('/api/threads', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        model: selectedModel,
      }),
    });

    if (thread) {
      setThreadId(thread.id);
    }
  }, [authToken, selectedModel]);

  useEffect(() => {
    (async () => {
      if (fileData.length === 0) {
        return;
      }

      // We do this with an additional user interaction on mobile, so skip here
      if (isMobile) {
        return;
      }

      // Check if this file is already in the files array to prevent duplicates
      setFiles((current) => {
        const alreadyExists = current.some((file) => file.id === fileData[0].id);

        if (alreadyExists) {
          return current;
        }

        return [...current, fileData[0]];
      });

      // Only create thread if we don't have one yet
      if (threadId == null) {
        await createFileThread();
      }
    })();
  }, [fileData, isMobile, createFileThread, threadId]);

  const handleSelectLastCapture = useCallback(async () => {
    if (fileData.length === 0) {
      return;
    }

    // Only create thread if we don't have one yet
    if (threadId == null) {
      await createFileThread();
    }

    // Check if this file is already in the files array to prevent duplicates
    setFiles((current) => {
      const alreadyExists = current.some((file) => file.id === fileData[0].id);

      if (alreadyExists) {
        return current;
      }

      return [...current, fileData[0]];
    });
  }, [fileData, createFileThread, threadId]);

  const handleSubmit = useCallback(
    async (data: FormData, e?: FormEvent) => {
      e?.preventDefault();

      const fileIds = files.map((file) => file.id);

      return submitChatRequest({ ...data, fileIds });
    },
    [files, submitChatRequest],
  );

  if (isMobile) {
    if (files.length === 0) {
      return (
        <InlineModal open={open} onClose={handleClose} className="fixed">
          <div className="absolute top-[env(safe-area-inset-top)] right-0 z-10">
            <div className="flex-1 text-right text-white">
              <Button variant="ghost" size="icon" onClick={handleClose}>
                <X />
              </Button>
            </div>
          </div>

          <Camera
            onFrameCaptured={handleMobileFrameCaptured}
            onRecordingFinished={handleCapturedMedia}
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
      <InlineModal open={open} onClose={handleClose}>
        <div className="flex flex-row items-center border-b bg-stone-50 dark:bg-secondary gap-2 p-2 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="flex items-center flex-1">
            <Popover>
              <Popover.Trigger>
                <Button className="flex-1" variant="ghost" size="icon">
                  <Settings />
                </Button>
              </Popover.Trigger>
              <Popover.Content className="p-2 relative left-2 w-auto">
                <ModelSelector withToggles visionOnly />
              </Popover.Content>
            </Popover>
          </div>

          <div className="flex items-center justify-center font-bold">{fileData[0]?.name}</div>

          <div className="flex items-center justify-end flex-1">
            <Button variant="ghost" size="icon" onClick={handleClose}>
              <X />
            </Button>
          </div>
        </div>

        <Chat
          placeholder="Ask about this content..."
          loading={loading}
          streaming={streaming}
          hasStartedReceiving={hasStartedReceiving}
          readable={stream ?? undefined}
          onSubmit={handleSubmit}
          onStop={stopChatRequest}
        >
          <Files files={files} />
        </Chat>
      </InlineModal>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <Dialog.Content
        className={cn(
          'w-[90vw] h-[90vh] sm:max-w-[90vw] sm:max-h-[80vh] p-0 flex flex-col gap-0',
          files.length > 0 && 'max-[900px]:h-[80vh]',
        )}
        showCloseButton={false}
      >
        <Dialog.Header className="flex flex-row items-center justify-between border-b bg-stone-50 dark:bg-secondary rounded-t-lg gap-2 p-2 pl-4">
          <Dialog.Title className="flex-1">Upload Images and Videos</Dialog.Title>
          <Dialog.Description className="hidden">Capture audio or video and upload to CI</Dialog.Description>

          <ModelSelector withToggles visionOnly />

          <div className="flex items-center justify-end">
            <Button variant="ghost" size="icon" onClick={handleClose}>
              <X />
            </Button>
          </div>
        </Dialog.Header>

        {files.length === 0 && (
          <Camera
            onFrameCaptured={handleCapturedMedia}
            onRecordingFinished={handleCapturedMedia}
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
                hasStartedReceiving={hasStartedReceiving}
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
              <div key={file.id} className="aspect-video rounded-lg overflow-hidden bg-stone-100">
                <video controls className="w-full h-full object-cover">
                  <source src={`/static${file.url}`} type={file.contentType} />
                  Your browser does not support the video tag.
                </video>
              </div>
            );
          case 'audio':
            return (
              <div
                key={file.id}
                className="rounded-lg overflow-hidden bg-stone-100 p-4 flex items-center justify-center"
              >
                <audio controls className="w-full">
                  <source src={`/static${file.url}`} type={file.contentType} />
                  Your browser does not support the audio element.
                </audio>
              </div>
            );
          case 'image':
            return (
              <div key={file.id} className="rounded-lg bg-stone-100">
                <img src={`/static${file.url}`} className="w-full h-full object-cover" />
              </div>
            );
        }
      })}
    </>
  );
}
