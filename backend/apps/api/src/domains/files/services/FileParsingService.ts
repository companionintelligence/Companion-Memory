import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/services';

import { FileEntity } from '../entities/FileEntity';
import { FileService } from './FileService';

@Injectable()
export class FileParsingService {
  private logger = new LoggerService(FileParsingService.name);

  constructor(
    @InjectRepository(FileEntity)
    private readonly fileRepository: Repository<FileEntity>,
    private readonly fileService: FileService,
  ) {}

  async parseFile(fileId: string): Promise<void> {
    this.logger.debug(`Starting file parsing for fileId: ${fileId}`);

    try {
      // Update status to processing
      await this.updateParsingStatus(fileId, 'processing');

      const file = await this.fileRepository.findOneBy({ id: fileId });
      if (!file) {
        throw new Error(`File not found: ${fileId}`);
      }

      // Get file content from Minio
      const fileContent = await this.fileService.getFileContent({} as any, file.key);
      
      // Parse based on content type
      const { content, metadata } = await this.parseByContentType(
        file.content_type,
        fileContent,
        file.original_name,
      );

      // Save parsed content and metadata
      await this.fileRepository.update(fileId, {
        parsed_content: content,
        parsed_metadata: metadata,
        parsing_status: 'completed',
        parsed_at: new Date(),
        parsing_error: undefined,
      });

      this.logger.debug(`Successfully parsed file: ${fileId}`);
    } catch (error) {
      this.logger.error(`Failed to parse file ${fileId}:`, error as Error);
      
      await this.fileRepository.update(fileId, {
        parsing_status: 'failed',
        parsing_error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private async parseByContentType(
    contentType: string,
    content: Uint8Array,
    filename: string,
  ): Promise<{ content: string; metadata: Record<string, any> }> {
    const textContent = new TextDecoder().decode(content);
    
    // Basic text parsing for common text files
    if (this.isTextFile(contentType, filename)) {
      return this.parseTextFile(textContent);
    }

    // For other file types, store basic metadata for now
    return {
      content: `Binary file (${contentType})`,
      metadata: {
        contentType,
        filename,
        size: content.length,
        parsedAs: 'binary',
      },
    };
  }

  private isTextFile(contentType: string, filename: string): boolean {
    const textContentTypes = [
      'text/plain',
      'text/markdown',
      'text/html',
      'text/css',
      'text/javascript',
      'application/json',
      'application/javascript',
      'application/xml',
      'text/xml',
    ];

    const textExtensions = ['.txt', '.md', '.json', '.js', '.ts', '.html', '.css', '.xml'];
    
    return (
      textContentTypes.includes(contentType) ||
      textExtensions.some(ext => filename.toLowerCase().endsWith(ext))
    );
  }

  private parseTextFile(content: string): { content: string; metadata: Record<string, any> } {
    const lines = content.split('\n');
    const wordCount = content.split(/\s+/).filter(word => word.length > 0).length;
    const charCount = content.length;

    return {
      content: content.trim(),
      metadata: {
        lineCount: lines.length,
        wordCount,
        charCount,
        parsedAs: 'text',
        encoding: 'utf-8',
      },
    };
  }

  private async updateParsingStatus(
    fileId: string,
    status: 'pending' | 'processing' | 'completed' | 'failed',
  ): Promise<void> {
    await this.fileRepository.update(fileId, {
      parsing_status: status,
    });
  }
}