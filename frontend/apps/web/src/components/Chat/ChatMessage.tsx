import { parseChatContent, ThinkBlock, ToolBlock } from '../ChatBlocks';

import { AssistantMessage } from './blocks/AssistantMessage';
import { UserMessage } from './blocks/UserMessage';

interface Props {
  role: string;
  content: string;
}

export function ChatMessage({ role, content }: Props) {
  if (role === 'tool') {
    return null;
  }

  if (role === 'user') {
    return <UserMessage content={content} />;
  }

  const segments = parseChatContent(content);

  if (segments.length === 0) {
    return null;
  }

  return (
    <>
      {segments.map((segment) => {
        switch (segment.type) {
          case 'text':
            return <AssistantMessage content={segment.content} />;
          case 'think':
            return <ThinkBlock content={segment.content} defaultExpanded={true} />;
          case 'tool':
            return <ToolBlock toolName={segment.toolName} />;
          default:
            return null;
        }
      })}
    </>
  );
}
