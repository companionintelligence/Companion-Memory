import { extname } from 'node:path';

import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { type ParsedDocument } from '../types';

import {
  type DocumentExtractor,
  type DocumentParseRequest,
  type DocumentParseTarget,
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
      body: form,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');

      throw new Error(`Parser service returned ${response.status}: ${body}`);
    }

    this.logger.log('Parsed document via MarkItDown', {
      mimeType: input.mimeType,
      filename: input.filename,
    });

    return response.json() as Promise<ParsedDocument>;
  }
}
