import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';

import { type PythonRunCallbackRequest, PythonRunCallbackGuard } from '../guards/PythonRunCallbackGuard';
import type { PythonFunctionTokenService } from '../services/PythonFunctionTokenService';

function contextFor(req: Partial<PythonRunCallbackRequest>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('PythonRunCallbackGuard', () => {
  const tokens = {
    verifyCallbackToken: jest.fn((token: string) => {
      if (token !== 'good') {
        throw new UnauthorizedException('bad');
      }

      return { userId: 'user-1', jobId: 'job-1', queue: 'py-fn-hbpe' };
    }),
  } as unknown as PythonFunctionTokenService;
  const guard = new PythonRunCallbackGuard(tokens);

  it('admits a bearer run token and leaves its claims on the request for the controller', () => {
    const req: Partial<PythonRunCallbackRequest> = { headers: { authorization: 'Bearer good' } } as never;

    expect(guard.canActivate(contextFor(req))).toBe(true);
    expect(req.pythonRun).toEqual({ userId: 'user-1', jobId: 'job-1', queue: 'py-fn-hbpe' });
  });

  it('refuses a missing bearer and a bad token — a session or api key is not a run token', () => {
    expect(() => guard.canActivate(contextFor({ headers: {} } as never))).toThrow(UnauthorizedException);
    expect(() =>
      guard.canActivate(contextFor({ headers: { authorization: 'Bearer nope' } } as never)),
    ).toThrow(UnauthorizedException);
  });
});
