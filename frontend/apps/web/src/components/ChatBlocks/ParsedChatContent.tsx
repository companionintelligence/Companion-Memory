import React from 'react';

import { parseChatContent } from './parser';
import { TextBlock } from './TextBlock';
import { ThinkBlock } from './ThinkBlock';
import { ToolBlock } from './ToolBlock';

interface ParsedChatContentProps {
  content: string;
}

export const ParsedChatContent: React.FC<ParsedChatContentProps> = ({ content }) => {
  const segments = parseChatContent(content);

  if (segments.length === 0) {
    // Fallback to simple text rendering if no segments found
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      return null;
    }

    return <div className="whitespace-pre-wrap leading-relaxed">{trimmedContent}</div>;
  }

  return (
    <div className="space-y-3">
      {segments.map((segment, index) => {
        switch (segment.type) {
          case 'text':
            return <TextBlock key={`text-${index}`} content={segment.content} />;
          case 'think':
            return <ThinkBlock key={`think-${index}`} content={segment.content} defaultExpanded={true} />;
          case 'tool':
            return <ToolBlock key={`tool-${index}`} toolName={segment.toolName} />;
          default:
            return null;
        }
      })}
    </div>
  );
};
