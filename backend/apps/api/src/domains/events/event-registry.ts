interface EventPayload {
  name?: never;
}

export enum Events {
  API_ENQUEUE = 'api.enqueue',
  FILE_UPLOAD = 'file.upload',
  CHAT_SUMMARIZATION = 'chat.summarization',
  INFER_QUESTION_ANSWER = 'infer.question.answer',
  SYNC_CONNECTION = 'sync.connection',
  MCP_TOOL_CALL = 'mcp.tool.call',
}

interface ApiEnqueuePayload extends EventPayload {
  foo: string;
  bar: string;
}

interface FileUploadPayload extends EventPayload {
  fileId: string;
}

interface ChatSummarizationPayload extends EventPayload {
  ownerId: string;
  threadId: string;
}

interface InferQuestionAnswerPayload extends EventPayload {
  ownerId: string;
  questionId: string;
}

interface SyncConnectionPayload extends EventPayload {
  connectionId: string;
  userId: string;
}
interface McpToolCallPayload extends EventPayload {
  userId: string;
  toolName: string;
  arguments: unknown;
}

export type EventPayloads = {
  [Events.API_ENQUEUE]: ApiEnqueuePayload;
  [Events.FILE_UPLOAD]: FileUploadPayload;
  [Events.CHAT_SUMMARIZATION]: ChatSummarizationPayload;
  [Events.INFER_QUESTION_ANSWER]: InferQuestionAnswerPayload;
  [Events.SYNC_CONNECTION]: SyncConnectionPayload;
  [Events.MCP_TOOL_CALL]: McpToolCallPayload;
};
