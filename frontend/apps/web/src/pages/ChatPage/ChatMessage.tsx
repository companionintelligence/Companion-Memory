import React from 'react';

import { cn } from '@ci/shadcn';
import { Bot } from '@ci/shadcn/icons';

interface ChatMessageProps {
  message: { role: 'user' | 'assistant'; content: string };
  index: number;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({ message, index }) => (
  <div
    className={cn(
      'flex gap-3 animate-in fade-in-0 slide-in-from-bottom-2 duration-300',
      message.role === 'user' ? 'justify-end' : 'justify-start',
    )}
    style={{ animationDelay: `${index * 100}ms` }}
  >
    {message.role === 'assistant' && (
      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary/10 to-primary/20 flex items-center justify-center flex-shrink-0 mt-1 shadow-sm border border-primary/20">
        <Bot className="h-4 w-4 text-primary" />
      </div>
    )}

    <div
      className={cn(
        'max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm transition-all duration-200 hover:shadow-md',
        message.role === 'user'
          ? 'bg-gradient-to-br from-primary to-primary/90 text-primary-foreground ml-auto shadow-md'
          : 'bg-gradient-to-br from-muted to-muted/80 text-foreground border border-border/50 backdrop-blur-sm',
      )}
    >
      <div className="whitespace-pre-wrap">{message.content}</div>
      <div
        className={cn(
          'text-xs opacity-70 mt-2 text-right',
          message.role === 'user' ? 'text-primary-foreground/80' : 'text-muted-foreground',
        )}
      >
        {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </div>
    </div>

    {message.role === 'user' && (
      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary/20 to-primary/30 flex items-center justify-center flex-shrink-0 mt-1 shadow-sm border border-primary/30">
        <div className="w-2 h-2 rounded-full bg-primary-foreground" />
      </div>
    )}
  </div>
);
