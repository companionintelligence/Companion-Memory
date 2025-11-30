import { Cron as NestCron, type CronOptions } from '@nestjs/schedule';
import { v4 as uuidv4 } from 'uuid';

import { ContextService } from '../services/ContextService';

export function Cron(expression: string, options?: CronOptions) {
  return function (target: object, propertyName: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: unknown[]) {
      const traceId = uuidv4();

      return ContextService.run({ traceId }, () => originalMethod.apply(this, args));
    };

    return NestCron(expression, options)(target, propertyName, descriptor);
  };
}
