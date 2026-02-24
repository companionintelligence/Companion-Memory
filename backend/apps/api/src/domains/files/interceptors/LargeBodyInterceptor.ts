import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { json } from 'express';
import { Observable } from 'rxjs';

/**
 * Interceptor that applies a larger JSON body size limit (50mb) for file upload endpoints.
 * This overrides the global 100kb limit to allow large metadata payloads with file uploads.
 */
@Injectable()
export class LargeBodyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    // Apply json middleware with 50mb limit
    const middleware = json({ limit: '50mb' });

    return new Observable((observer) => {
      middleware(request, response, (err?: unknown) => {
        if (err) {
          observer.error(err);
        } else {
          next.handle().subscribe({
            next: (data) => observer.next(data),
            error: (error) => observer.error(error),
            complete: () => observer.complete(),
          });
        }
      });
    });
  }
}
