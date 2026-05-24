import { createHash } from 'crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'stream/promises';

import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, type FindOptionsWhere } from 'typeorm';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { EventService } from '@ci/domains/events';
import { FileUpdatedEvent, FileUploadedEvent } from '@ci/domains/files/events';

import { SignedFile, FileEntity } from '../entities/FileEntity';
import { FileVariant, type CreateFileDto, type UpdateFileDto, type UploadFileDto } from '../types';

const BUCKET_REGION = config.staticfiles.bucket ?? 'us-east-1';
const SIGNATURE_URL = config.staticfiles.auth.signatureUrl ?? config.staticfiles.storageUrl;

@Injectable()
export class FileService implements OnModuleInit {
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
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FileService.name);
  }

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

  async create(context: UserServiceContext, file: CreateFileDto): Promise<SignedFile> {
    if (file.externalId) {
      const existing = await this.findByExternalId(context, file.externalId);

      if (existing) {
        this.logger.debug('File with same external ID already exists', {
          existingFileId: existing.id,
        });

        return existing;
      }
    }

    const hash = await this.getFileHash(file);

    if (hash) {
      const existing = await this.findByHash(context, hash);

      if (existing) {
        this.logger.debug('File with same hash already exists', {
          existingFileId: existing.id,
        });

        return existing;
      }
    }

    const bucket = file.externalId ? null : config.staticfiles.bucket;
    const key = bucket ? uuidv4() : null;

    const entity = this.fileRepository.create({
      id: uuidv7(),
      filename: file.filename,
      contentType: file.contentType ?? 'application/octet-stream',
      size: file.size,
      width: file.width ?? null,
      height: file.height ?? null,
      variant: file.variant ?? FileVariant.ORIGINAL,
      title: file.title ?? null,
      description: file.description ?? null,
      externalId: file.externalId ?? null,
      bucket,
      key,
      hash,
      parentId: file.parentId,
      userId: context.userId,
      externalCreatedAt: file.externalCreatedAt,
      externalUpdatedAt: file.externalUpdatedAt,
    });

    const result = await this.fileRepository.save(entity);

    if (file.externalId == null) {
      const putOptions = {
        Bucket: result.bucket!,
        Key: result.key!,
        ContentType: result.contentType,
      };

      if (file.buffer) {
        await this.s3.send(
          new PutObjectCommand({
            ...putOptions,
            Body: file.buffer,
          }),
        );
      } else if (file.path) {
        await this.s3.send(
          new PutObjectCommand({
            ...putOptions,
            Body: createReadStream(file.path),
          }),
        );
      }
    }

    return this.signFile(result);
  }

  async findAll(context: ServiceContext): Promise<SignedFile[]> {
    const result = await this.fileRepository.find({
      where: {
        variant: FileVariant.ORIGINAL,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
      order: {
        createdAt: 'DESC',
      },
    });

    return this.signFiles(result);
  }

  async findById(context: ServiceContext, id: string): Promise<SignedFile | null> {
    const result = await this.fileRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    return result ? this.signFile(result) : null;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(SignedFile | null)[]> {
    if (ids.length === 0) {
      return [];
    }

    const entities = await this.fileRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    const signedFiles = await this.signFiles(entities);

    const map = new Map(signedFiles.map((file) => [file.id, file]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findByHash(context: UserServiceContext, fileHash: string): Promise<SignedFile | null> {
    const result = await this.fileRepository.findOne({
      where: {
        hash: fileHash,
        userId: context.userId,
      },
    });

    if (result == null) {
      return null;
    }

    return this.signFile(result);
  }

  async findByExternalId(context: UserServiceContext, externalId: string): Promise<SignedFile | null> {
    const result = await this.fileRepository.findOne({
      where: {
        externalId,
        userId: context.userId,
      },
    });

    if (result == null) {
      return null;
    }

    return this.signFile(result);
  }

  async findVariantByParentId(
    context: ServiceContext,
    id: string,
    variant: FileVariant,
  ): Promise<SignedFile | null> {
    const result = await this.fileRepository.findOne({
      where: {
        parentId: id,
        variant,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    if (result == null) {
      return null;
    }

    return this.signFile(result);
  }

  async findVariantsByParentIds(
    context: ServiceContext,
    parentIds: string[],
    variant: FileVariant,
  ): Promise<(SignedFile | null)[]> {
    if (parentIds.length === 0) {
      return [];
    }

    const entities = await this.fileRepository.find({
      where: {
        parentId: In(parentIds),
        variant,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    const signedFiles = await this.signFiles(entities);

    const map = new Map(signedFiles.map((file) => [file.parentId, file]));

    return parentIds.map((id) => map.get(id) ?? null);
  }

  async upload(context: UserServiceContext, file: UploadFileDto): Promise<SignedFile> {
    const { inventoryCapture = false, model, ...uploadData } = file;
    const hash = await this.getFileHash(uploadData);

    if (hash) {
      const existing = await this.findByHash(context, hash);

      if (existing) {
        this.logger.debug('File with same hash already exists, skipping upload', {
          existingFileId: existing.id,
        });

        if (inventoryCapture) {
          await this.eventService.send(FileUploadedEvent, {
            fileId: existing.id,
            userId: context.userId,
            inventoryCapture: true,
            model,
          });
        }

        return existing;
      }
    }

    const created = await this.create(context, {
      ...uploadData,
      variant: FileVariant.ORIGINAL,
    });

    await this.eventService.send(FileUploadedEvent, {
      fileId: created.id,
      userId: context.userId,
      inventoryCapture,
      model,
    });

    return created;
  }

  async getFileContent(context: ServiceContext, key: string): Promise<Uint8Array> {
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

  async getFileStream(context: ServiceContext, key: string): Promise<Readable> {
    const response = await this.s3.send(
      new GetObjectCommand({
        Bucket: config.staticfiles.bucket,
        Key: key,
      }),
    );

    if (!response.Body) {
      throw new Error(`S3 object body was empty for key: ${key}`);
    }

    // AWS SDK v3 SdkStream implements Symbol.asyncIterator, so we can
    // wrap it in a Node Readable without unsafe casts or web-stream mismatches.
    return Readable.from(response.Body as AsyncIterable<Uint8Array>);
  }

  async update(context: ServiceContext, id: string, data: UpdateFileDto): Promise<SignedFile | null> {
    await this.fileRepository.update(
      {
        id,
        ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
      },
      data,
    );

    await this.eventService.send(FileUpdatedEvent, { fileId: id });

    return this.findById(context, id);
  }

  async search(context: ServiceContext, query: FindOptionsWhere<FileEntity>): Promise<FileEntity[]> {
    return this.fileRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
        ...query,
      },
    });
  }

  async getFileHash(file: CreateFileDto): Promise<string | null> {
    if (file.buffer) {
      return createHash('sha256').update(file.buffer).digest('hex');
    }

    if (file.path) {
      const hash = createHash('sha256');

      await pipeline(createReadStream(file.path), hash);

      return hash.digest('hex');
    }

    return null;
  }

  private async signFiles(files: FileEntity[]): Promise<SignedFile[]> {
    return Promise.all(files.map(this.signFile.bind(this)));
  }

  private async signFile(file: FileEntity): Promise<SignedFile> {
    const bucket = file.bucket;
    const key = file.key;

    if (bucket == null || key == null) {
      return {
        ...FileEntity.toEgressType(file),
        url: file.externalId,
      };
    }

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentType: file.contentType,
    });

    const url = await getSignedUrl(this.signatureS3, command, {
      expiresIn: config.staticfiles.auth.signatureTTL,
    });

    const parsedUrl = new URL(url);

    return {
      ...FileEntity.toEgressType(file),
      url: parsedUrl.pathname + parsedUrl.search,
    };
  }
}
