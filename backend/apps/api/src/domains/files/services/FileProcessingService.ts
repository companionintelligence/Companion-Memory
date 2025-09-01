import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as exifr from 'exifr';
import pdfParse from 'pdf-parse';

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
      const fileType = this.getFileTypeDescription(file.content_type);
      let analysis = `File: ${file.original_name} (${fileType})`;
      
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
        const preview = metadata.textContent.length > 500 
          ? `${metadata.textContent.substring(0, 500)}...` 
          : metadata.textContent;
        analysis += `\nContent preview: ${preview}`;
      }
      
      if (metadata.exif && Object.keys(metadata.exif).length > 0) {
        const relevantExif = Object.entries(metadata.exif)
          .filter(([key, value]) => value && this.isRelevantExifField(key))
          .slice(0, 5);
        
        if (relevantExif.length > 0) {
          analysis += '\nCamera info: ' + relevantExif.map(([k, v]) => `${k}: ${v}`).join(', ');
        }
      }
      
      return analysis;
    });

    const fileTypesSummary = this.generateFileTypesSummary(processedFiles);
    return `I've uploaded ${processedFiles.length} file(s): ${fileTypesSummary}. Please analyze and discuss them:\n\n${analyses.join('\n\n')}`;
  }

  private getFileTypeDescription(contentType: string): string {
    if (contentType.startsWith('image/')) return 'Image';
    if (contentType.startsWith('video/')) return 'Video';
    if (contentType.startsWith('audio/')) return 'Audio';
    if (contentType.startsWith('text/') || this.isTextFile(contentType)) return 'Text Document';
    if (contentType === 'application/pdf') return 'PDF Document';
    if (contentType.includes('word') || contentType.includes('msword')) return 'Word Document';
    if (contentType.includes('excel') || contentType.includes('spreadsheet')) return 'Spreadsheet';
    if (contentType.includes('powerpoint') || contentType.includes('presentation')) return 'Presentation';
    return 'File';
  }

  private generateFileTypesSummary(processedFiles: ProcessedFile[]): string {
    const typeCounts = processedFiles.reduce((acc, { file }) => {
      const type = this.getFileTypeDescription(file.content_type);
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return Object.entries(typeCounts)
      .map(([type, count]) => count === 1 ? type : `${count} ${type}s`)
      .join(', ');
  }

  private isRelevantExifField(key: string): boolean {
    return key.match(/date|camera|lens|iso|exposure|focal|aperture|make|model|software/i) !== null;
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
      } else if (file.content_type === 'application/pdf') {
        await this.extractPdfContent(metadata, content);
      } else if (this.isTextFile(file.content_type)) {
        await this.extractTextContent(metadata, content);
      }
    } catch (error) {
      this.logger.warn(`Failed to extract metadata for file ${file.id}: ${(error as Error).message}`);
    }

    return metadata;
  }

  private async extractImageMetadata(metadata: FileMetadata, content: Uint8Array): Promise<void> {
    try {
      // Use exifr to extract EXIF data from images
      const exifData = await exifr.parse(content, {
        gps: true,
        tiff: true,
        exif: true,
        iptc: false,
        icc: false,
      });

      if (exifData) {
        metadata.exif = exifData;
        
        // Extract GPS location if available
        if (exifData.latitude && exifData.longitude) {
          metadata.location = {
            latitude: exifData.latitude,
            longitude: exifData.longitude,
          };
        }
        
        // Extract image dimensions
        if (exifData.ImageWidth && exifData.ImageHeight) {
          metadata.dimensions = {
            width: exifData.ImageWidth,
            height: exifData.ImageHeight,
          };
        }
      }
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

  private async extractPdfContent(metadata: FileMetadata, content: Uint8Array): Promise<void> {
    try {
      // Use pdf-parse to extract text content from PDF
      const buffer = Buffer.from(content);
      const data = await pdfParse(buffer);
      
      metadata.textContent = data.text;
      
      // Additional PDF metadata
      if (data.info) {
        metadata.exif = {
          title: data.info.Title,
          author: data.info.Author,
          subject: data.info.Subject,
          creator: data.info.Creator,
          producer: data.info.Producer,
          creationDate: data.info.CreationDate,
          modificationDate: data.info.ModDate,
          pages: data.numpages,
        };
      }
    } catch (error) {
      this.logger.warn(`Failed to extract PDF content: ${(error as Error).message}`);
    }
  }

  private isTextFile(contentType: string): boolean {
    return (
      contentType.startsWith('text/') ||
      contentType === 'application/json' ||
      contentType === 'application/xml' ||
      contentType === 'application/yaml' ||
      contentType === 'application/x-yaml' ||
      contentType.includes('javascript') ||
      contentType.includes('typescript') ||
      contentType.includes('markdown') ||
      contentType === 'application/csv' ||
      contentType === 'text/csv' ||
      contentType === 'application/sql'
    );
  }
}