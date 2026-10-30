import { type ParsedDocument } from '../types';

export const DOCUMENT_EXTRACTORS = Symbol('DOCUMENT_EXTRACTORS');

export type DocumentParseTarget = {
  mimeType: string;
  filename: string;
};

export type DocumentParseRequest = DocumentParseTarget & {
  fileBytes: Uint8Array;
};

export interface DocumentExtractor {
  readonly key: string;

  supports(target: DocumentParseTarget): boolean;

  parse(input: DocumentParseRequest): Promise<ParsedDocument>;
}

/**
 * The largest file sent to the parser: the parser sidecar's own upload limit
 * (MAX_UPLOAD_BYTES in backend/apps/summary/src/ci/summary/parser_worker.py).
 * The file is read into memory whole to be sent, so a larger one is refused
 * before it is downloaded rather than by the parser after.
 */
export const MAX_PARSE_BYTES = 100 * 1024 * 1024;

/**
 * The extractor looked at this file and will not, or cannot, turn it into text:
 * too large, an archive that inflates too far, a format it does not read, or a
 * conversion that ran out of time or memory. Sending the same bytes again gets
 * the same answer, so the parse job records the failure and does not retry.
 */
export class UnparseableDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnparseableDocumentError';
  }
}
