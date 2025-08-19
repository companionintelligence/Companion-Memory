import type { ChatSegment } from './types';

export interface StreamingState {
  segments: ChatSegment[];
  currentThinkContent: string;
  currentToolContent: string;
  isInThink: boolean;
  isInTool: boolean;
  pendingText: string;
}

/**
 * Parses streaming content that may be incomplete
 * Returns segments and current streaming state
 */
export function parseStreamingContent(content: string): {
  segments: ChatSegment[];
  isInThink: boolean;
  currentThinkContent: string;
} {
  const segments: ChatSegment[] = [];
  let currentIndex = 0;
  let isInThink = false;
  let currentThinkContent = '';

  while (currentIndex < content.length) {
    // Look for opening tags
    const thinkStart = content.indexOf('<think>', currentIndex);
    const toolStart = content.indexOf('<tool>', currentIndex);

    // Find the next opening tag (whichever comes first)
    let nextTagStart = -1;
    let nextTagType: 'think' | 'tool' | null = null;

    if (thinkStart !== -1 && (toolStart === -1 || thinkStart < toolStart)) {
      nextTagStart = thinkStart;
      nextTagType = 'think';
    } else if (toolStart !== -1) {
      nextTagStart = toolStart;
      nextTagType = 'tool';
    }

    // If no more opening tags found
    if (nextTagStart === -1) {
      const remainingText = content.slice(currentIndex);

      if (isInThink) {
        // We're in a think block, add remaining content to current think content
        currentThinkContent += remainingText;
      } else if (remainingText.trim()) {
        // Regular text outside think blocks
        segments.push({
          type: 'text',
          content: remainingText.trim(),
        });
      }

      break;
    }

    // Add any text before the tag
    if (nextTagStart > currentIndex) {
      const textBefore = content.slice(currentIndex, nextTagStart);

      if (isInThink) {
        currentThinkContent += textBefore;
      } else if (textBefore.trim()) {
        segments.push({
          type: 'text',
          content: textBefore.trim(),
        });
      }
    }

    // Process the opening tag
    if (nextTagType === 'think') {
      // Check if we have a closing tag
      const thinkEnd = content.indexOf('</think>', nextTagStart);

      if (thinkEnd !== -1) {
        // Complete think block
        const thinkContent = content.slice(nextTagStart + 7, thinkEnd); // +7 for '<think>'
        segments.push({
          type: 'think',
          content: thinkContent,
        });
        currentIndex = thinkEnd + 8; // +8 for '</think>'
      } else {
        // Incomplete think block - we're currently streaming inside it
        isInThink = true;
        currentThinkContent = content.slice(nextTagStart + 7); // Everything after <think>
        break; // Exit loop since we're in streaming mode
      }
    } else if (nextTagType === 'tool') {
      const toolEnd = content.indexOf('</tool>', nextTagStart);

      if (toolEnd !== -1) {
        // Complete tool block
        const toolContent = content.slice(nextTagStart + 6, toolEnd); // +6 for '<tool>'
        const toolName = extractToolName(toolContent);

        const toolSegment: ChatSegment = {
          type: 'tool',
          toolName,
          content: toolContent,
        };

        if (isInThink) {
          // Tool is inside a think block, add to current think content as embedded tool
          currentThinkContent += `<tool>${toolContent}</tool>`;
        } else {
          // Standalone tool block
          segments.push(toolSegment);
        }

        currentIndex = toolEnd + 7; // +7 for '</tool>'
      } else {
        // Incomplete tool - treat as part of current context
        const incompleteToolContent = content.slice(nextTagStart);
        if (isInThink) {
          currentThinkContent += incompleteToolContent;
        } else {
          // Standalone incomplete tool - treat as text for now
          if (incompleteToolContent.trim()) {
            segments.push({
              type: 'text',
              content: incompleteToolContent.trim(),
            });
          }
        }

        break;
      }
    }
  }

  return {
    segments,
    isInThink,
    currentThinkContent,
  };
}

/**
 * Extracts tool name from tool content
 */
function extractToolName(toolContent: string): string {
  const content = toolContent.trim();

  if (!content) {
    return 'Unknown Tool';
  }

  // Try to find function name in JSON format: "name": "function_name"
  const functionMatch = content.match(/"name":\s*"([^"]+)"/);
  if (functionMatch && functionMatch[1]) {
    return functionMatch[1];
  }

  // Try to find function call pattern: functionName(
  const callMatch = content.match(/(\w+)\s*\(/);
  if (callMatch && callMatch[1]) {
    return callMatch[1];
  }

  // Try to find tool names with underscores or "Tool" suffix
  const toolMatch = content.match(/(\w+_\w+|\w+Tool|\w+Service)/);
  if (toolMatch && toolMatch[1]) {
    return toolMatch[1];
  }

  // Try to find any word longer than 2 characters at the start
  const firstWordMatch = content.match(/^(\w{3,})/);
  if (firstWordMatch && firstWordMatch[1]) {
    return firstWordMatch[1];
  }

  return 'Unknown Tool';
}
