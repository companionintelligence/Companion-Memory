import { Inject, Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import { DOCUMENT_EXTRACTORS, type DocumentExtractor, type DocumentParseTarget } from './DocumentExtractor';

@Injectable()
export class DocumentParserRegistry {
  constructor(
    @Inject(DOCUMENT_EXTRACTORS)
    private readonly extractors: DocumentExtractor[],
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DocumentParserRegistry.name);
  }

  supports(target: DocumentParseTarget): boolean {
    return this.findExtractor(target) != null;
  }

  resolve(target: DocumentParseTarget): DocumentExtractor | null {
    const extractor = this.findExtractor(target);

    if (extractor) {
      this.logger.log('Resolved document extractor', {
        extractor: extractor.key,
        mimeType: target.mimeType,
        filename: target.filename,
      });
    }

    return extractor;
  }

  private findExtractor(target: DocumentParseTarget): DocumentExtractor | null {
    return this.extractors.find((candidate) => candidate.supports(target)) ?? null;
  }
}
