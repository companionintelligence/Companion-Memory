import React from 'react';

import { parseChatContent } from './parser';
import { parseStreamingContent } from './streamingParser';
import { TextBlock } from './TextBlock';
import { ThinkBlock } from './ThinkBlock';
import { ToolBlock } from './ToolBlock';

interface StreamingChatContentProps {
  content: string;
  isStreaming?: boolean;
}

export const StreamingChatContent: React.FC<StreamingChatContentProps> = ({
  content,
  isStreaming = false,
}) => {
  if (!isStreaming) {
    // Use regular parser for complete content
    const segments = parseChatContent(content);

    if (segments.length === 0) {
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
  }

  // Use streaming parser for partial content
  const { segments, isInThink, currentThinkContent } = parseStreamingContent(content);

  return (
    <div className="space-y-3">
      {/* Render completed segments */}
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

      {/* Render currently streaming think block */}
      {isInThink && currentThinkContent && (
        <ThinkBlock key="streaming-think" content={currentThinkContent} defaultExpanded={true} />
      )}
    </div>
  );
};
