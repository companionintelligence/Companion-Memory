import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/services';
import type { RequestContext } from '@ci/common/types';

import { FileEntity } from '../entities/FileEntity';
import { FileService } from './FileService';

export interface FileMetadata {
  exif?: Record<string, any>;
  location?: {
    latitude: number;
    longitude: number;
  };
  duration?: number;
  dimensions?: {
    width: number;
    height: number;
  };
  textContent?: string;
}

export interface ProcessedFile {
  file: FileEntity;
  metadata: FileMetadata;
  content?: Uint8Array;
}

@Injectable()
export class FileProcessingService {
  private readonly logger = new LoggerService(FileProcessingService.name);

  constructor(
    @InjectRepository(FileEntity)
    private readonly fileRepository: Repository<FileEntity>,
    private readonly fileService: FileService,
  ) {}

  async processFiles(context: RequestContext, fileIds: string[]): Promise<ProcessedFile[]> {
    const files = await this.getValidatedFiles(context, fileIds);
    
    const processedFiles = await Promise.all(
      files.map(async (file) => {
        const content = await this.fileService.getFileContent(context, file.key);
        const metadata = await this.extractMetadata(file, content);
        
        return {
          file,
          metadata,
          content,
        };
      })
    );

    return processedFiles;
  }

  async generateFileAnalysisPrompt(processedFiles: ProcessedFile[]): Promise<string> {
    const analyses = processedFiles.map(({ file, metadata }) => {
      let analysis = `File: ${file.original_name} (${file.content_type})`;
      
      if (metadata.dimensions) {
        analysis += `\nDimensions: ${metadata.dimensions.width}x${metadata.dimensions.height}`;
      }
      
      if (metadata.location) {
        analysis += `\nLocation: ${metadata.location.latitude}, ${metadata.location.longitude}`;
      }
      
      if (metadata.duration) {
        analysis += `\nDuration: ${metadata.duration} seconds`;
      }
      
      if (metadata.textContent) {
        analysis += `\nText content: ${metadata.textContent.substring(0, 500)}...`;
      }
      
      if (metadata.exif && Object.keys(metadata.exif).length > 0) {
        const relevantExif = Object.entries(metadata.exif)
          .filter(([key, value]) => value && key.match(/date|camera|lens|iso|exposure/i))
          .slice(0, 5);
        
        if (relevantExif.length > 0) {
          analysis += '\nCamera info: ' + relevantExif.map(([k, v]) => `${k}: ${v}`).join(', ');
        }
      }
      
      return analysis;
    });

    return `I've uploaded ${processedFiles.length} file(s). Please analyze and discuss them:\n\n${analyses.join('\n\n')}`;
  }

  private async getValidatedFiles(context: RequestContext, fileIds: string[]): Promise<FileEntity[]> {
    const files = await this.fileRepository.find({
      where: fileIds.map(id => ({
        id,
        user: {
          id: context.userId,
        },
      })),
    });

    if (files.length !== fileIds.length) {
      const foundIds = files.map(f => f.id);
      const missingIds = fileIds.filter(id => !foundIds.includes(id));
      throw new Error(`Files not found: ${missingIds.join(', ')}`);
    }

    return files;
  }

  private async extractMetadata(file: FileEntity, content: Uint8Array): Promise<FileMetadata> {
    const metadata: FileMetadata = {};

    try {
      if (file.content_type.startsWith('image/')) {
        await this.extractImageMetadata(metadata, content);
      } else if (file.content_type.startsWith('video/')) {
        await this.extractVideoMetadata(metadata, content);
      } else if (file.content_type.startsWith('audio/')) {
        await this.extractAudioMetadata(metadata, content);
      } else if (this.isTextFile(file.content_type)) {
        await this.extractTextContent(metadata, content);
      }
    } catch (error) {
      this.logger.warn(`Failed to extract metadata for file ${file.id}: ${(error as Error).message}`);
    }

    return metadata;
  }

  private async extractImageMetadata(metadata: FileMetadata, content: Uint8Array): Promise<void> {
    // TODO: Implement EXIF extraction using a library like 'exifr' or 'piexifjs'
    // For now, we'll just extract basic info
    try {
      // Basic image analysis placeholder
      // In a real implementation, you would use libraries like:
      // - exifr for EXIF data
      // - sharp for image processing and metadata
      metadata.exif = {}; // Placeholder for EXIF data
    } catch (error) {
      this.logger.warn(`Failed to extract image metadata: ${(error as Error).message}`);
    }
  }

  private async extractVideoMetadata(metadata: FileMetadata, content: Uint8Array): Promise<void> {
    // TODO: Implement video metadata extraction using ffmpeg or similar
    try {
      // Placeholder for video metadata extraction
      // In a real implementation, you would use libraries like:
      // - ffmpeg for video analysis
      // - node-ffmpeg or fluent-ffmpeg
      metadata.duration = 0; // Placeholder
      metadata.dimensions = { width: 0, height: 0 }; // Placeholder
    } catch (error) {
      this.logger.warn(`Failed to extract video metadata: ${(error as Error).message}`);
    }
  }

  private async extractAudioMetadata(metadata: FileMetadata, content: Uint8Array): Promise<void> {
    // TODO: Implement audio metadata extraction
    try {
      // Placeholder for audio metadata extraction
      // In a real implementation, you would use libraries like:
      // - node-id3 for MP3 metadata
      // - music-metadata for various audio formats
      metadata.duration = 0; // Placeholder
    } catch (error) {
      this.logger.warn(`Failed to extract audio metadata: ${(error as Error).message}`);
    }
  }

  private async extractTextContent(metadata: FileMetadata, content: Uint8Array): Promise<void> {
    try {
      // For text files, extract the content directly
      const text = new TextDecoder('utf-8').decode(content);
      metadata.textContent = text;
    } catch (error) {
      this.logger.warn(`Failed to extract text content: ${(error as Error).message}`);
    }
  }

  private isTextFile(contentType: string): boolean {
    return (
      contentType.startsWith('text/') ||
      contentType === 'application/json' ||
      contentType === 'application/xml' ||
      contentType.includes('javascript') ||
      contentType.includes('typescript') ||
      contentType.includes('markdown')
    );
  }
}