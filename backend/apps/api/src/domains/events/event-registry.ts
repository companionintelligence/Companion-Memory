interface EventPayload {
  name?: never;
}

export enum Events {
  API_ENQUEUE = 'api.enqueue',
  FILE_UPLOAD = 'file.upload',
  CHAT_SUMMARIZATION = 'chat.summarization',
  INFER_QUESTION_ANSWER = 'infer.question.answer',
  SYNC_CONNECTION = 'sync.connection',
  ETL_DATA_COLLECTION = 'etl.data.collection',
  ETL_TRANSFORM = 'etl.transform',
  ETL_SCHEDULE = 'etl.schedule',
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

interface EtlDataCollectionPayload extends EventPayload {
  jobId: string;
  connectionId: string;
  endpointConfigId: string;
}

interface EtlTransformPayload extends EventPayload {
  jobId: string;
  transformMapId: string;
  sourceData: unknown;
}

interface EtlSchedulePayload extends EventPayload {
  jobId: string;
}

export type EventPayloads = {
  [Events.API_ENQUEUE]: ApiEnqueuePayload;
  [Events.FILE_UPLOAD]: FileUploadPayload;
  [Events.CHAT_SUMMARIZATION]: ChatSummarizationPayload;
  [Events.INFER_QUESTION_ANSWER]: InferQuestionAnswerPayload;
  [Events.SYNC_CONNECTION]: SyncConnectionPayload;
  [Events.ETL_DATA_COLLECTION]: EtlDataCollectionPayload;
  [Events.ETL_TRANSFORM]: EtlTransformPayload;
  [Events.ETL_SCHEDULE]: EtlSchedulePayload;
};
