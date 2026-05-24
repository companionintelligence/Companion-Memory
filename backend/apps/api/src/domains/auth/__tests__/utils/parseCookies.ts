import type request from 'supertest';

export interface ParsedCookie {
  value: string;
  httpOnly?: boolean;
  secure?: boolean;
  path?: string;
  maxAge?: number;
  sameSite?: string;
  expires?: Date;
}

/**
 * Parse Set-Cookie headers into a keyed map for easy assertion.
 */
export function parseCookies(response: request.Response): Record<string, ParsedCookie> {
  const result: Record<string, ParsedCookie> = {};
  const headers = response.headers['set-cookie'];

  if (!headers) {
    return result;
  }

  const cookieStrings = Array.isArray(headers) ? headers : [headers];

  for (const str of cookieStrings) {
    const parts = str.split(';').map((s: string) => s.trim());
    const [nameVal, ...attrs] = parts;
    const eqIdx = nameVal.indexOf('=');
    const name = nameVal.substring(0, eqIdx);
    const value = nameVal.substring(eqIdx + 1);

    const cookie: ParsedCookie = { value };

    for (const attr of attrs) {
      const lower = attr.toLowerCase();

      if (lower === 'httponly') {
        cookie.httpOnly = true;
      } else if (lower === 'secure') {
        cookie.secure = true;
      } else if (lower.startsWith('path=')) {
        cookie.path = attr.split('=')[1];
      } else if (lower.startsWith('max-age=')) {
        cookie.maxAge = Number(attr.split('=')[1]);
      } else if (lower.startsWith('samesite=')) {
        cookie.sameSite = attr.split('=')[1];
      } else if (lower.startsWith('expires=')) {
        cookie.expires = new Date(attr.substring('expires='.length));
      }
    }

    result[name] = cookie;
  }

  return result;
}
