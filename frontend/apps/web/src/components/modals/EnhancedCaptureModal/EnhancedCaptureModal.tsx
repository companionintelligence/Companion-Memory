import { useCallback, useRef, useState, type FormEvent } from 'react';
import { Camera } from '@ci/capture';
import { Button, Dialog, Badge, Tabs } from '@ci/shadcn';
import { Send, Lightbulb, CameraIcon } from '@ci/shadcn/icons';

import type { File as CIFile } from '@/api/types.ts';
import { Chat, type FormData } from '@/components/Chat';
import { useAuth, useChatRequester, useModel } from '@/hooks';
import { getMediaType } from '@/lib/utils';

import type { CaptureCategory } from './types';
import { CAPTURE_CATEGORIES } from './categoryConfigs';

interface Props {
  open?: boolean;
  initialFiles?: CIFile[];
  initialCategory?: CaptureCategory;
  onClose?: () => void;
}

export function EnhancedCaptureModal({ 
  open = false, 
  initialFiles = [], 
  initialCategory = 'documents',
  onClose 
}: Props) {
  const [files, setFiles] = useState<CIFile[]>(initialFiles);
  const [selectedCategory, setSelectedCategory] = useState<CaptureCategory>(initialCategory);
  const [showSuggestedPrompts, setShowSuggestedPrompts] = useState(true);
  const threadId = useRef<string | null>(null);

  const categoryConfig = CAPTURE_CATEGORIES[selectedCategory];

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setFiles([]);
      setSelectedCategory('documents');
      setShowSuggestedPrompts(true);
      threadId.current = null;
      onClose?.();
    }
  }, [onClose]);

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
      setShowSuggestedPrompts(false);
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
        return;
      }

      // Create thread with category context
      const threadRes = await fetch('/api/threads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          files: [{ id: resJson.id }],
          model: selectedModel,
          metadata: {
            category: selectedCategory,
            categoryLabel: categoryConfig.label,
            captureInstructions: categoryConfig.captureInstructions
          }
        }),
      });

      const threadResJson = await threadRes.json();

      if (!threadRes.ok) {
        console.error('Linking file to thread failed', threadResJson);
        return;
      }

      threadId.current = threadResJson.id;

      setFiles(prevFiles => prevFiles.concat({
        url: URL.createObjectURL(file),
        ...resJson,
      }));
    },
    [authToken, selectedModel, selectedCategory, categoryConfig],
  );

  const handleSuggestedPromptClick = useCallback((prompt: string) => {
    handleSubmit({ message: prompt } as FormData);
  }, [handleSubmit]);

  const categories = Object.values(CAPTURE_CATEGORIES);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Dialog.Content className="sm:max-w-[85vw] max-h-[85vh] p-0 flex flex-col gap-0">
        <Dialog.Header className="flex flex-col gap-3 p-4 pb-3 border-b bg-stone-50 rounded-t-2xl">
          <div className="flex flex-row items-center justify-between">
            <Dialog.Title>Enhanced Capture Tools</Dialog.Title>
            <Badge variant="outline" className="text-xs">
              {categoryConfig.label}
            </Badge>
          </div>
          <Dialog.Description className="hidden">
            Capture content with category-specific tools and AI assistance
          </Dialog.Description>
          
          {/* Category Selection */}
          <div className="flex flex-wrap gap-2">
            {categories.map((category) => (
              <Button
                key={category.id}
                variant={selectedCategory === category.id ? "default" : "outline"}
                size="sm"
                onClick={() => setSelectedCategory(category.id)}
                className="flex items-center gap-1.5"
              >
                <category.icon className="w-3.5 h-3.5" />
                {category.label}
              </Button>
            ))}
          </div>

          {/* Category Instructions */}
          <div className="text-sm text-gray-600 bg-blue-50 p-3 rounded-lg">
            <div className="font-medium text-blue-900 mb-1">{categoryConfig.description}</div>
            <div className="text-blue-700">{categoryConfig.captureInstructions}</div>
          </div>
        </Dialog.Header>

        {files.length === 0 && (
          <div className="min-h-[400px]">
            <Camera onFrameCaptured={handleMediaCaptured} onRecordingFinished={handleMediaCaptured}>
              <Camera.Feed />
            </Camera>
          </div>
        )}

        {files.length > 0 && (
          <div className="flex flex-1 max-h-[600px]">
            {/* Left side: file preview */}
            <div className="flex flex-col gap-4 p-4 border-r min-w-[320px] max-w-[480px] w-full">
              {files.map((file, index) => {
                const fileType = getMediaType(file.contentType);
                switch (fileType) {
                  case 'video':
                    return (
                      <div key={index} className="aspect-video rounded-lg overflow-hidden bg-stone-100">
                        <video controls className="w-full h-full object-cover">
                          <source src={file.url} type={file.contentType} />
                          Your browser does not support the video tag.
                        </video>
                      </div>
                    );
                  case 'audio':
                    return (
                      <div key={index} className="rounded-lg overflow-hidden bg-stone-100 p-4 flex items-center justify-center">
                        <audio controls className="w-full">
                          <source src={file.url} type={file.contentType} />
                          Your browser does not support the audio element.
                        </audio>
                      </div>
                    );
                  case 'image':
                  default:
                    return (
                      <div key={index} className="aspect-video rounded-lg overflow-hidden bg-stone-100">
                        <img src={file.url} className="w-full h-full object-cover" alt="Captured content" />
                      </div>
                    );
                }
              })}

              {/* Recapture button */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setFiles([]);
                  threadId.current = null;
                  setShowSuggestedPrompts(true);
                }}
                className="mt-2"
              >
                <CameraIcon className="w-4 h-4 mr-2" />
                Capture Another
              </Button>
            </div>

            {/* Right side: Chat with suggested prompts */}
            <div className="flex-1 min-w-0 max-h-[600px] overflow-y-auto flex flex-col">
              {showSuggestedPrompts && (
                <div className="p-4 border-b bg-amber-50">
                  <div className="flex items-center gap-2 mb-3">
                    <Lightbulb className="w-4 h-4 text-amber-600" />
                    <span className="text-sm font-medium text-amber-900">
                      Suggested questions for {categoryConfig.label.toLowerCase()}:
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {categoryConfig.suggestedPrompts.map((prompt, index) => (
                      <Button
                        key={index}
                        variant="outline"
                        size="sm"
                        onClick={() => handleSuggestedPromptClick(prompt)}
                        className="text-xs h-8 bg-white hover:bg-amber-100 border-amber-200"
                      >
                        {prompt}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex-1">
                <Chat
                  loading={loading}
                  streaming={streaming}
                  readable={stream ?? undefined}
                  onSubmit={handleSubmit}
                  onStop={stopChatRequest}
                  placeholder={`Ask about this ${categoryConfig.label.toLowerCase()} content...`}
                  emptyState={
                    <div className="text-center text-gray-500 mt-8">
                      <div className="w-16 h-16 mx-auto mb-4 bg-stone-100 rounded-full flex items-center justify-center">
                        <Send className="w-8 h-8 text-zinc-400 relative top-0.5 -left-0.5" />
                      </div>
                      <p className="text-sm">Start analyzing your {categoryConfig.label.toLowerCase()}</p>
                      <p className="text-xs text-gray-400 mt-1">
                        Use the suggested prompts above or ask your own questions
                      </p>
                    </div>
                  }
                />
              </div>
            </div>
          </div>
        )}
      </Dialog.Content>
    </Dialog>
  );
}