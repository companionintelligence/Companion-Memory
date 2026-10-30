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

/**
 * Any UUID Postgres would accept, whatever its version and variant nibbles.
 *
 * This guard only keeps garbage away from `uuid` columns; it is not where an
 * id's version is checked. It used to accept only v4 and v7 with an RFC 4122
 * variant, and the seeded Slack (`019e3c66-b5d2-7f03-c9e5-…`, variant `c`) and
 * Signal (`019e3d77-c6e3-8f14-da06-…`, version 8) provider rows fall outside
 * that, so `/providers/:id` answered 404 for them before any provider code ran
 * and neither service could ever be connected.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUUID(id: string) {
  return UUID_PATTERN.test(id);
}
