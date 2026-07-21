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
