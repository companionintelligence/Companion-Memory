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
