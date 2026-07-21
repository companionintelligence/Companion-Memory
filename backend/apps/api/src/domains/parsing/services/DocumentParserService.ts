import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import { type ParsedDocument } from '../types';

import { DocumentParserRegistry } from './DocumentParserRegistry';

@Injectable()
export class DocumentParserService {
  constructor(
    private readonly registry: DocumentParserRegistry,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DocumentParserService.name);
  }

  canParse(mimeType: string, filename: string): boolean {
    return this.registry.supports({ mimeType, filename });
  }

  async parse(fileBytes: Uint8Array, mimeType: string, filename: string): Promise<ParsedDocument> {
    const extractor = this.registry.resolve({ mimeType, filename });

    if (extractor == null) {
      throw new Error(`No document extractor available for ${mimeType} (${filename})`);
    }

    this.logger.log('Dispatching parse request', {
      extractor: extractor.key,
      mimeType,
      filename,
    });

    return extractor.parse({ fileBytes, mimeType, filename });
  }
}
