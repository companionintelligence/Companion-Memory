import { extname } from 'node:path';

import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { sidecarAuthHeaders } from '@ci/common/sidecar/sidecarAuth';
import config from '@ci/configuration';

import { type ParsedDocument } from '../types';

import {
  type DocumentExtractor,
  type DocumentParseRequest,
  type DocumentParseTarget,
  UnparseableDocumentError,
} from './DocumentExtractor';

const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/msword',
  'text/csv',
  'text/plain',
  'text/markdown',
]);

const SUPPORTED_EXTENSIONS = new Set(['.csv', '.doc', '.docx', '.md', '.pdf', '.txt', '.xls', '.xlsx']);

/**
 * How long one parse request may take end to end. The sidecar converts one
 * document at a time and gives each 120 s (parser_worker.py), so this leaves
 * room to wait behind a couple of slow ones. Without it the call ended only on
 * undici's default 300 s header timeout, and not at all while a response body
 * trickled in.
 */
export const PARSER_REQUEST_TIMEOUT_MS = 5 * 60_000;

/**
 * Answers about the document itself: too large or an archive that inflates too
 * far (413), a type the parser does not read (415), a conversion that failed or
 * ran out of memory (422) or out of time (504). Retrying sends the same bytes
 * for the same answer.
 */
const DOCUMENT_REFUSED_STATUSES = new Set([413, 415, 422, 504]);

@Injectable()
export class MarkItDownExtractor implements DocumentExtractor {
  readonly key = 'markitdown';

  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(MarkItDownExtractor.name);
  }

  supports(target: DocumentParseTarget): boolean {
    const normalizedExtension = extname(target.filename).toLowerCase();

    return SUPPORTED_MIME_TYPES.has(target.mimeType) || SUPPORTED_EXTENSIONS.has(normalizedExtension);
  }

  async parse(input: DocumentParseRequest): Promise<ParsedDocument> {
    const url = `${config.services.parser.host}/parse`;
    const form = new FormData();

    form.append('file', new Blob([input.fileBytes], { type: input.mimeType }), input.filename);
    form.append('mime_type', input.mimeType);

    const response = await fetch(url, {
      method: 'POST',
      headers: sidecarAuthHeaders(),
      body: form,
      signal: AbortSignal.timeout(PARSER_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const message = `Parser service returned ${response.status}: ${body}`;

      throw DOCUMENT_REFUSED_STATUSES.has(response.status)
        ? new UnparseableDocumentError(message)
        : new Error(message);
    }

    this.logger.log('Parsed document via MarkItDown', {
      mimeType: input.mimeType,
      filename: input.filename,
    });

    return response.json() as Promise<ParsedDocument>;
  }
}
