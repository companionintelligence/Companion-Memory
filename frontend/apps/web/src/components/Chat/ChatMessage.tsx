import { AssistantMessage } from './blocks/AssistantMessage';
import { ThinkBlock } from './blocks/ThinkBlock';
import { ToolBlock } from './blocks/ToolBlock';
import { UserMessage } from './blocks/UserMessage';
import { parseChatContent } from './parser';

interface ToolCallShape {
  function?: { name?: string };
}

interface Props {
  role: string;
  content: string;
  createdAt?: string;
  source?: 'openclaw' | 'memory' | 'user';
  toolCalls?: object[] | null;
}

function persistedToolNames(toolCalls: object[] | null | undefined): string[] {
  if (!toolCalls?.length) {
    return [];
  }

  return toolCalls.flatMap((call) => {
    const name = (call as ToolCallShape).function?.name;

    return name ? [name] : [];
  });
}

export function ChatMessage({ role, content, createdAt, source, toolCalls }: Props) {
  if (role === 'tool') {
    return null;
  }

  if (role === 'user') {
    return <UserMessage content={content} createdAt={createdAt} />;
  }

  const segments = parseChatContent(content);
  const contentShowsTools = segments.some((segment) => segment.type === 'tool');
  const toolNames = contentShowsTools ? [] : persistedToolNames(toolCalls);

  if (segments.length === 0 && toolNames.length === 0) {
    return null;
  }

  return (
    <>
      {segments.map((segment) => {
        switch (segment.type) {
          case 'text':
            return <AssistantMessage content={segment.content} createdAt={createdAt} source={source} />;
          case 'think':
            return <ThinkBlock content={segment.content} defaultExpanded={false} />;
          case 'tool':
            return <ToolBlock toolName={segment.toolName} />;
          default:
            return null;
        }
      })}
      {toolNames.map((toolName, index) => (
        <ToolBlock key={`${toolName}-${index}`} toolName={toolName} />
      ))}
    </>
  );
}
