interface EventPayload {
  name?: never;
}

export enum Events {
  API_ENQUEUE = 'api.enqueue',
  FILE_UPLOAD = 'file.upload',
  CHAT_SUMMARIZATION = 'chat.summarization',
  INFER_QUESTION_ANSWER = 'infer.question.answer',
  SYNC_CONNECTION = 'sync.connection',
  MCP_CALL = 'mcp.call',
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

interface McpCallPayload extends EventPayload {
  toolName: string;
  arguments: Record<string, unknown>;
  userId: string;
  requestId: string;
}

export type EventPayloads = {
  [Events.API_ENQUEUE]: ApiEnqueuePayload;
  [Events.FILE_UPLOAD]: FileUploadPayload;
  [Events.CHAT_SUMMARIZATION]: ChatSummarizationPayload;
  [Events.INFER_QUESTION_ANSWER]: InferQuestionAnswerPayload;
  [Events.SYNC_CONNECTION]: SyncConnectionPayload;
  [Events.MCP_CALL]: McpCallPayload;
};
