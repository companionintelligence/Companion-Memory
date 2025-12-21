import { createHmac } from 'crypto';
import { Readable } from 'stream';

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { FileService, FileEntity } from '@ci/domains/files';

@Injectable()
export class FacebookPromotionUtils {
  constructor(
    private readonly fileService: FileService,
    @InjectRepository(FileEntity)
    private readonly fileRepository: Repository<FileEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FacebookPromotionUtils.name);
  }

  async downloadAndSaveFile(
    url: string,
    externalId: string,
    userId: string,
    connectionId: string,
    mediaType: 'image' | 'video',
    filename: string,
  ): Promise<{ id: string; contentType: string } | null> {
    try {
      // Download the file
      const response = await fetch(url);
      if (!response.ok) {
        this.logger.error('Failed to download file', {
          url,
          status: response.status,
          statusText: response.statusText,
        });

        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const contentType =
        response.headers.get('content-type') || (mediaType === 'image' ? 'image/jpeg' : 'video/mp4');

      // Check if file already exists by hash or cloudFileId
      const fileHash = createHmac('sha256', config.auth.session.fieldPepper).update(buffer).digest('hex');
      const existingFiles = await this.fileService.search(
        { userId },
        {
          fileHash: fileHash,
          contentType: contentType,
        },
      );

      // Also check by cloudFileId (Facebook ID)
      if (existingFiles.length === 0) {
        const existingByCloudId = await this.fileService.search(
          { userId },
          {
            cloudFileId: externalId,
            storageProvider: 'facebook',
          },
        );
        if (existingByCloudId.length > 0) {
          existingFiles.push(...existingByCloudId);
        }
      }

      if (existingFiles.length > 0) {
        this.logger.debug('File already exists, skipping upload', {
          fileId: existingFiles[0].id,
          url,
        });

        return {
          id: existingFiles[0].id,
          contentType: existingFiles[0].contentType,
        };
      }

      // Create a multer-like file object
      const fileExtension = this.getFileExtension(contentType, url);
      const fullFilename = filename.includes('.') ? filename : `${filename}.${fileExtension}`;

      // Create a Readable stream from the buffer
      const stream = Readable.from(buffer);

      const multerFile: Express.Multer.File = {
        fieldname: 'file',
        originalname: fullFilename,
        encoding: '7bit',
        mimetype: contentType,
        size: buffer.length,
        buffer,
        destination: '',
        filename: fullFilename,
        path: '',
        stream,
      };

      // Upload to S3/MinIO
      const fileRecord = await this.fileService.upload({ userId }, multerFile);

      // Update file record with Facebook metadata (cloudFileId and storageProvider)
      const fileEntity = await this.fileRepository.findOne({
        where: { id: fileRecord.id },
      });

      if (fileEntity) {
        fileEntity.cloudFileId = externalId;
        fileEntity.storageProvider = 'facebook';
        await this.fileRepository.save(fileEntity);
        this.logger.debug('Updated file record with Facebook metadata', {
          fileId: fileRecord.id,
          cloudFileId: externalId,
        });
      }

      return {
        id: fileRecord.id,
        contentType: fileRecord.contentType,
      };
    } catch (error) {
      this.logger.error('Error downloading and saving file', {
        url,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return null;
    }
  }

  getFileExtension(contentType: string, url: string): string {
    // Try to get extension from content type
    if (contentType.includes('jpeg') || contentType.includes('jpg')) {
      return 'jpg';
    }

    if (contentType.includes('png')) {
      return 'png';
    }

    if (contentType.includes('gif')) {
      return 'gif';
    }

    if (contentType.includes('webp')) {
      return 'webp';
    }

    if (contentType.includes('mp4')) {
      return 'mp4';
    }

    if (contentType.includes('webm')) {
      return 'webm';
    }

    // Try to get extension from URL
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
      if (match) {
        return match[1].toLowerCase();
      }
    } catch {
      // Invalid URL, continue
    }

    // Default based on media type
    return 'jpg';
  }

  getBestImageSource(photo: {
    images?: Array<{ height: number; width: number; source: string }>;
    picture?: string;
    link?: string;
  }): string | null {
    if (!photo.images || photo.images.length === 0) {
      return photo.picture || photo.link || null;
    }

    // Sort by width * height to get the largest image
    const sortedImages = [...photo.images].sort((a, b) => b.width * b.height - a.width * a.height);

    return sortedImages[0]?.source || photo.picture || photo.link || null;
  }
}
