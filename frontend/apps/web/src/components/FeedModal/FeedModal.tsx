import React from 'react';

import { Button, Dialog } from '@ci/shadcn';
import { X, Send, ThumbsUp, ThumbsDown } from '@ci/shadcn/icons';

import { Chat } from '../Chat/Chat';

interface FeedModalProps {
  isOpen: boolean;
  onClose: () => void;
  item: FeedItem | null;
  className?: string;
  onLike?: (itemId: string) => void;
  onDislike?: (itemId: string) => void;
}

interface FeedItem {
  id: string;
  title: string;
  description: React.ReactNode;
  tags: string[];
  imageUrl?: string;
}

export function FeedModal({ isOpen, onClose, item, onLike, onDislike }: FeedModalProps) {
  if (!item) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content className="w-full max-w-5xl h-[85vh] p-0 overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 bg-white flex-shrink-0">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <h2 className="text-2xl font-bold text-gray-900">{item.title}</h2>
              <div className="flex flex-wrap gap-2 mt-2">
                {item.tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-2 py-1 text-xs font-medium bg-teal-100 text-teal-800 rounded-full"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Action Buttons */}
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 bg-stone-50 cursor-pointer hover:bg-stone-100"
              onClick={() => onLike?.(item.id)}
            >
              <ThumbsUp className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 bg-stone-50 cursor-pointer hover:bg-stone-100"
              onClick={() => onDislike?.(item.id)}
            >
              <ThumbsDown className="h-4 w-4" />
            </Button>
            {/* Close Button */}
            <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8 hover:bg-gray-100">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Content */}
        <div className="flex flex-1 min-h-0">
          {/* Left Panel - Card Details */}
          <div className="w-1/2 flex flex-col border-r border-gray-200 min-h-0">
            <div className="flex-1 overflow-y-auto p-4 min-h-0">
              <div className="space-y-4">
                {/* Image */}
                {item.imageUrl && (
                  <div className="aspect-video rounded-lg overflow-hidden bg-gray-100">
                    <img src={item.imageUrl} alt={item.title} className="w-full h-full object-cover" />
                  </div>
                )}

                {/* Description */}
                <div className="prose prose-sm max-w-none">
                  <div className="text-gray-700">{item.description}</div>
                </div>

                {/* Additional Info */}
                <div className="bg-gray-50 rounded-lg p-4">
                  <h3 className="text-sm font-semibold text-gray-900 mb-2">Quick Actions</h3>
                  <div className="space-y-2">
                    <Button variant="outline" size="sm" className="w-full justify-start">
                      Save to favorites
                    </Button>
                    <Button variant="outline" size="sm" className="w-full justify-start">
                      Share with family
                    </Button>
                    <Button variant="outline" size="sm" className="w-full justify-start">
                      Add to calendar
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Right Panel - Chat */}
          <div className="w-1/2 flex flex-col min-h-0">
            <Chat
              placeholder="Ask about this content..."
              emptyState={
                <div className="text-center text-gray-500 mt-8">
                  <div className="w-16 h-16 mx-auto mb-4 bg-gray-100 rounded-full flex items-center justify-center">
                    <Send className="w-8 h-8 text-gray-400" />
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
      </Dialog.Content>
    </Dialog>
  );
}
