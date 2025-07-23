import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class IdFormatGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const id = req.params?.id || req.params?.uuid || req.params?.gid;

    if (!id) {
      return true;
    }

    if (!UUID_PATTERN.test(id)) {
      throw new NotFoundException();
    }

    return true;
  }
}
