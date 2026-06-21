declare module 'undici' {
  export class Agent {
    constructor(opts?: {
      connect?: { rejectUnauthorized?: boolean };
      keepAliveTimeout?: number;
      keepAliveMaxTimeout?: number;
    });
  }

  export function fetch(input: string | URL, init?: RequestInit & { dispatcher?: Agent }): Promise<Response>;
}
