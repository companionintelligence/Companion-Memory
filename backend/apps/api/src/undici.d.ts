import type { LookupFunction } from 'node:net';

declare module 'undici' {
  export class Agent {
    constructor(opts?: {
      connect?: {
        rejectUnauthorized?: boolean;
        /**
         * Custom DNS resolution for every connection this agent opens. The
         * unfurl fetcher uses it to refuse private/link-local addresses at
         * connect time, so the address that was validated is the one dialled
         * (no resolve-then-connect TOCTOU / DNS-rebind window).
         */
        lookup?: LookupFunction;
        timeout?: number;
      };
      keepAliveTimeout?: number;
      keepAliveMaxTimeout?: number;
      maxRedirections?: number;
    });
  }

  export function fetch(input: string | URL, init?: RequestInit & { dispatcher?: Agent }): Promise<Response>;
}
