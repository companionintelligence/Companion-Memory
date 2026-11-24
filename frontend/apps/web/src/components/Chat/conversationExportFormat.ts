import { parseGrounding } from './GroundingSources';
import { parseChatContent } from './parser';

export interface ExportMessage {
  role: string;
  content: string;
  grounding?: unknown;
  incomplete?: boolean;
}

export type ConversationExportFormat = 'txt' | 'md' | 'json';

export function buildConversationExport(
  title: string,
  messages: ExportMessage[],
  format: ConversationExportFormat,
) {
  const safeTitle = title.trim() || 'Conversation';
  const filename = `${
    safeTitle
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 90) || 'conversation'
  }.${format}`;
  const turns = messages.filter((message) => message.role === 'user' || message.role === 'assistant');

  if (format === 'json') {
    return {
      filename,
      mimeType: 'application/json',
      content: JSON.stringify({ version: 1, title: safeTitle, messages: turns }, null, 2),
    };
  }

  const content = [
    format === 'md' ? `# ${safeTitle}` : safeTitle,
    ...turns.map((message) => {
      const speaker = message.role === 'user' ? 'You' : 'Companion';
      const text =
        message.role === 'user'
          ? message.content
          : parseChatContent(message.content)
              .filter((segment) => segment.type === 'text')
              .map((segment) => segment.content)
              .join('\n\n');
      const grounding = parseGrounding(message.grounding);
      const evidence = grounding
        ? `\n\nMemory lookup: ${grounding.status}${grounding.sources.map((source) => `\n[M${source.citation}] ${source.text}`).join('')}${grounding.citations?.invalid.length ? `\nUnverified citations: ${grounding.citations.invalid.map((n) => `[M${n}]`).join(', ')}` : ''}`
        : '';

      return `${format === 'md' ? '## ' : ''}${speaker}${message.incomplete ? ' (incomplete reply)' : ''}\n\n${text}${evidence}`;
    }),
  ].join('\n\n');

  return { filename, mimeType: format === 'md' ? 'text/markdown' : 'text/plain', content };
}
