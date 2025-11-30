import { createHmac } from 'crypto';

import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, NotFoundException, OnModuleInit, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/services';
import { RequestContext } from '@ci/common/types';
import config from '@ci/configuration';
import { DeviceService } from '@ci/domains/devices';
import { EventService, Events } from '@ci/domains/events';
import { PositionService } from '@ci/domains/position';

import { FileEntity } from '../entities/FileEntity';
import type { File, FileQuery } from '../types';

const BUCKET_REGION = config.staticfiles.bucket ?? 'us-east-1';
const SIGNATURE_URL = config.staticfiles.auth.signatureUrl ?? config.staticfiles.storageUrl;

@Injectable()
export class FileService implements OnModuleInit {
  private logger = new LoggerService(FileService.name);

  private s3 = new S3Client({
    endpoint: config.staticfiles.storageUrl,
    // Minio doesn't care about the region, but we're specifying this default just to make S3 happy. May not be needed.
    region: BUCKET_REGION,
    // This is so the client is forced to use http://localhost:9000/example-bucket instead of subdomains.
    // We don't want file paths resolving to http://example-bucket.localhost:9000.
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.staticfiles.auth.accessKeyId,
      secretAccessKey: config.staticfiles.auth.secretAccessKey,
    },
  });

  private signatureS3 = new S3Client({
    endpoint: SIGNATURE_URL,
    region: BUCKET_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.staticfiles.auth.accessKeyId,
      secretAccessKey: config.staticfiles.auth.secretAccessKey,
    },
  });

  constructor(
    @InjectRepository(FileEntity)
    private readonly fileRepository: Repository<FileEntity>,
    private readonly eventService: EventService,
    private readonly deviceService: DeviceService,
    @Inject(forwardRef(() => PositionService))
    private readonly positionService: PositionService,
  ) {}

  async onModuleInit() {
    try {
      await this.s3.send(
        new HeadBucketCommand({
          Bucket: config.staticfiles.bucket,
        }),
      );

      this.logger.debug('S3 bucket exists, skipping creation');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        this.logger.debug('S3 bucket does not exist, creating a new bucket');

        await this.s3.send(
          new CreateBucketCommand({
            Bucket: config.staticfiles.bucket,
          }),
        );
      } else {
        throw err;
      }
    }
  }

  async findAll(context: RequestContext): Promise<File[]> {
    const result = await this.fileRepository.find({
      where: {
        user: {
          id: context.userId,
        },
      },
    });

    return this.signFiles(result);
  }

  async findOne(context: RequestContext, id: string): Promise<File> {
    const result = await this.fileRepository.findOne({
      where: {
        id,
        user: {
          id: context.userId,
        },
      },
    });

    if (result == null) {
      throw new NotFoundException();
    }

    return this.signFile(result);
  }

  async findByIds(context: RequestContext, ids: string[]): Promise<File[]> {
    if (ids.length === 0) {
      return [];
    }

    const entities = await this.fileRepository.find({
      where: {
        id: In(ids),
        user: {
          id: context.userId,
        },
      },
    });

    return this.signFiles(entities);
  }

  async upload(
    context: RequestContext,
    file: Express.Multer.File,
    documentMetadata?: Record<string, unknown>,
  ): Promise<File> {
    const fileId = uuidv7();
    const fileKey = uuidv4();
    const bucket = config.staticfiles.bucket;

    // Construct S3 path for file_path (required field)
    const filePath = `s3://${bucket}/${fileKey}`;

    const entity = this.fileRepository.create({
      id: fileId,
      file_path: filePath,
      filename: file.originalname,
      storage_type: 'cloud', // S3/Minio is cloud storage
      storage_provider: 's3',
      modified_at_source: new Date(), // Upload time as modification time
      bucket,
      key: fileKey,
      original_name: file.originalname,
      content_type: file.mimetype,
      size: file.size,
      file_hash: createHmac('sha256', config.auth.session.fieldPepper).update(file.buffer).digest('hex'),
      document_metadata: documentMetadata || {},
      user: {
        id: context.userId,
      },
    });

    const result = await this.fileRepository.save(entity);

    await this.s3.send(
      new PutObjectCommand({
        Bucket: result.bucket ?? config.staticfiles.bucket,
        Key: result.key!,
        Body: file.buffer,
        ContentType: result.content_type,
      }),
    );

    await this.eventService.send(Events.FILE_UPLOAD, {
      fileId: result.id,
      userId: context.userId,
    });

    // Create position record if location metadata exists
    if (documentMetadata?.location) {
      await this.createPositionFromMetadata(context, documentMetadata, result.id);
    }

    return this.signFile(entity);
  }

  private async createPositionFromMetadata(
    context: RequestContext,
    metadata: Record<string, unknown>,
    fileId: string,
  ): Promise<void> {
    try {
      const locationData = metadata.location as {
        latitude?: number;
        longitude?: number;
        accuracy?: number;
        timestamp?: number;
        altitude?: number;
        heading?: number;
        speed?: number;
      };

      if (!locationData?.latitude || !locationData?.longitude) {
        this.logger.debug('Location metadata missing required latitude/longitude', { fileId });

        return;
      }

      // Get or create a device for this user
      const device = await this.deviceService.getOrCreateDevice(context, undefined, {
        device_type: 'browser',
        platform: 'web',
      });

      // Create position record
      const positionTime = locationData.timestamp ? new Date(locationData.timestamp) : new Date();

      await this.positionService.create(context, [
        {
          time: positionTime.toISOString(),
          device_id: device.device_id,
          location: {
            x: locationData.longitude,
            y: locationData.latitude,
          },
          accuracy_meters: locationData.accuracy,
          altitude_meters: locationData.altitude ?? undefined,
          heading_degrees: locationData.heading ?? undefined,
          speed_meters_per_second: locationData.speed ?? undefined,
          source: 'gps',
          description: `Captured with file upload: ${fileId}`,
        },
      ]);

      this.logger.log('Created position record from file upload', {
        fileId,
        deviceId: device.device_id,
        userId: context.userId,
      });
    } catch (error) {
      // Log error but don't fail the file upload
      this.logger.error('Failed to create position record from file metadata', {
        fileId,
        error: error instanceof Error ? error.message : String(error),
        userId: context.userId,
      });
    }
  }

  async getFileContent(context: RequestContext, key: string): Promise<Uint8Array> {
    const response = await this.s3.send(
      new GetObjectCommand({
        Bucket: config.staticfiles.bucket,
        Key: key,
      }),
    );

    if (response.Body) {
      return response.Body.transformToByteArray();
    }

    throw new Error(`S3 object body was empty for key: ${key}`);
  }

  async generatePresignedLink(context: RequestContext, id: string): Promise<string> {
    const result = await this.fileRepository.findOne({
      where: {
        id,
        user: {
          id: context.userId,
        },
      },
    });

    if (result == null) {
      throw new NotFoundException();
    }

    if (!result.bucket || !result.key) {
      return result.file_path;
    }

    const command = new GetObjectCommand({
      Bucket: result.bucket ?? config.staticfiles.bucket,
      Key: result.key!,
      ResponseContentType: result.content_type,
    });

    const url = await getSignedUrl(this.signatureS3, command, {
      expiresIn: config.staticfiles.auth.signatureTTL,
    });

    return this.getKeyAndQuery(url);
  }

  async upsertExternal(
    context: RequestContext,
    input: {
      externalId: string;
      provider: string;
      filename: string;
      mimeType: string;
      url?: string | null;
      size?: number | string | null;
      modifiedAt?: string | Date | null;
      storageAccount?: string | null;
    },
  ): Promise<File> {
    const userId = context.userId;

    if (!userId) {
      throw new Error('User ID is required to store external files');
    }

    const provider = input.provider || 'external';
    const filePath = input.url ?? `external://${provider}/${input.externalId}`;
    const modifiedAt =
      input.modifiedAt instanceof Date
        ? input.modifiedAt
        : input.modifiedAt
          ? new Date(input.modifiedAt)
          : new Date();
    const rawSize =
      typeof input.size === 'string'
        ? Number.parseInt(input.size, 10)
        : typeof input.size === 'number'
          ? input.size
          : 0;
    const normalizedSize = Number.isFinite(rawSize) ? rawSize : 0;

    let entity = await this.fileRepository.findOne({
      where: {
        cloud_file_id: input.externalId,
        user: { id: userId },
      },
    });

    if (!entity) {
      entity = await this.fileRepository.findOne({
        where: {
          file_path: filePath,
          user: { id: userId },
        },
      });
    }

    if (entity) {
      this.logger.debug('Updating external file metadata', {
        userId,
        provider,
        externalId: input.externalId,
        filePath,
      });
      entity.filename = input.filename;
      entity.original_name = input.filename;
      entity.content_type = input.mimeType;
      entity.size = normalizedSize;
      entity.modified_at_source = modifiedAt;
      entity.storage_type = 'cloud';
      entity.storage_provider = provider;
      entity.cloud_file_id = input.externalId;
      entity.storage_account = input.storageAccount ?? entity.storage_account ?? null;
      entity.bucket = null;
      entity.key = entity.key ?? uuidv7();
      entity.file_path = filePath;
    } else {
      this.logger.debug('Creating external file record', {
        userId,
        provider,
        externalId: input.externalId,
        filePath,
      });
      entity = this.fileRepository.create({
        id: uuidv7(),
        file_path: filePath,
        filename: input.filename,
        storage_type: 'cloud',
        storage_provider: provider,
        cloud_file_id: input.externalId,
        storage_account: input.storageAccount ?? null,
        modified_at_source: modifiedAt,
        bucket: null,
        key: uuidv7(),
        original_name: input.filename,
        content_type: input.mimeType,
        size: normalizedSize,
        user: { id: userId },
      });
    }

    const saved = await this.fileRepository.save(entity);
    this.logger.debug('Upserted external file', { id: saved.id, userId, externalId: input.externalId });

    return this.signFile(saved);
  }

  async search(context: RequestContext, query: FileQuery): Promise<FileEntity[]> {
    return this.fileRepository.find({
      where: {
        user: {
          id: context.userId,
        },
        ...query,
      },
    });
  }

  private async signFiles(files: FileEntity[]): Promise<File[]> {
    return Promise.all(files.map(this.signFile.bind(this)));
  }

  private async signFile(file: FileEntity): Promise<File> {
    const bucket = file.bucket;
    const key = file.key;

    if (!bucket || !key) {
      return {
        ...file.toFile(),
        url: file.file_path,
      };
    }

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentType: file.content_type,
    });

    const url = await getSignedUrl(this.signatureS3, command, {
      expiresIn: config.staticfiles.auth.signatureTTL,
    });

    return {
      ...file.toFile(),
      url: this.getKeyAndQuery(url),
    };
  }

  private getKeyAndQuery(url: string): string {
    const parsed = new URL(url);

    return parsed.pathname + parsed.search;
  }
}
