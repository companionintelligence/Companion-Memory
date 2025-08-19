export interface TextSegment {
  type: 'text';
  content: string;
}

export interface ThinkSegment {
  type: 'think';
  content: string;
}

export interface ToolSegment {
  type: 'tool';
  toolName: string;
  content: string;
}

export type ChatSegment = TextSegment | ThinkSegment | ToolSegment;
