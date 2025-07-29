import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';
import { ZodSchema, type ZodTypeDef } from 'zod';

interface ValidationPipeOptions {
  parseJson?: boolean;
}

@Injectable()
export class ValidationPipe<T> implements PipeTransform {
  constructor(
    private schema: ZodSchema<T, ZodTypeDef, unknown>,
    private options: ValidationPipeOptions = {},
  ) {}

  transform(value: unknown): T {
    let transformedValue = value;

    if (this.options.parseJson === true && typeof value === 'string') {
      try {
        transformedValue = JSON.parse(value);
      } catch {
        throw new BadRequestException('Invalid JSON string');
      }
    }

    const result = this.schema.safeParse(transformedValue);

    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: result.error.issues,
      });
    }

    return result.data;
  }
}
