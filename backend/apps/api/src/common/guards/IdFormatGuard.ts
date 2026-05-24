import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';

@Injectable()
export class IdFormatGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const type = context.getType<'http' | 'graphql' | string>();

    if (type === 'graphql') {
      return true;
    }

    const req = context.switchToHttp().getRequest();
    const params = req?.params;

    if (!params) {
      return true;
    }

    for (const [key, value] of Object.entries(params)) {
      if (/id$/i.test(key) && typeof value === 'string' && !isUUID(value)) {
        throw new NotFoundException();
      }
    }

    return true;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUUID(id: string) {
  return UUID_PATTERN.test(id);
}
