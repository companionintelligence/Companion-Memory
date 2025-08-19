import type { ChatSegment } from './types';

const SORT_ORDER = {
  tool: 0,
  think: 1,
  text: 2,
} as const;

/**
 * Parses chat content and extracts think and tool blocks
 * Returns an array of segments with their types and content
 */
export function parseChatContent(content: string): ChatSegment[] {
  const segments: ChatSegment[] = [];
  let currentIndex = 0;

  while (currentIndex < content.length) {
    // Look for opening tags
    const thinkStart = content.indexOf('<think>', currentIndex);
    const toolStart = content.indexOf('<tool>', currentIndex);

    // Find the next tag (whichever comes first)
    let nextTagStart = -1;
    let nextTagType: 'think' | 'tool' | null = null;

    if (thinkStart !== -1 && (toolStart === -1 || thinkStart < toolStart)) {
      nextTagStart = thinkStart;
      nextTagType = 'think';
    } else if (toolStart !== -1) {
      nextTagStart = toolStart;
      nextTagType = 'tool';
    }

    // If no more tags found, add remaining content as text
    if (nextTagStart === -1) {
      const remainingText = content.slice(currentIndex).trim();
      if (remainingText) {
        segments.push({
          type: 'text',
          content: remainingText,
        });
      }

      break;
    }

    // Add any text before the tag
    if (nextTagStart > currentIndex) {
      const textBefore = content.slice(currentIndex, nextTagStart).trim();
      if (textBefore) {
        segments.push({
          type: 'text',
          content: textBefore,
        });
      }
    }

    // Process the tag
    if (nextTagType === 'think') {
      const thinkEnd = content.indexOf('</think>', nextTagStart);
      if (thinkEnd !== -1) {
        const thinkContent = content.slice(nextTagStart + 7, thinkEnd); // +7 for '<think>'
        segments.push({
          type: 'think',
          content: thinkContent,
        });
        currentIndex = thinkEnd + 8; // +8 for '</think>'
      } else {
        // Unclosed think tag - treat as text for now
        const remainingText = content.slice(currentIndex).trim();
        if (remainingText) {
          segments.push({
            type: 'text',
            content: remainingText,
          });
        }

        break;
      }
    } else if (nextTagType === 'tool') {
      const toolEnd = content.indexOf('</tool>', nextTagStart);
      if (toolEnd !== -1) {
        const toolContent = content.slice(nextTagStart + 6, toolEnd); // +6 for '<tool>'

        // Extract tool name from the content (assume it's structured like tool calls)
        const toolName = extractToolName(toolContent);

        segments.push({
          type: 'tool',
          toolName,
          content: toolContent,
        });
        currentIndex = toolEnd + 7; // +7 for '</tool>'
      } else {
        // Unclosed tool tag - treat as text for now
        const remainingText = content.slice(currentIndex).trim();
        if (remainingText) {
          segments.push({
            type: 'text',
            content: remainingText,
          });
        }

        break;
      }
    }
  }

  segments.sort((a, b) => {
    return SORT_ORDER[a.type as keyof typeof SORT_ORDER] - SORT_ORDER[b.type as keyof typeof SORT_ORDER];
  });

  return segments;
}

/**
 * Extracts tool name from tool content
 * Assumes tool content might contain function names or tool identifiers
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
