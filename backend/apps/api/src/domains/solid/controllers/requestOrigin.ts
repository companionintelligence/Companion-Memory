import type { Request } from 'express';

/**
 * Best-effort absolute origin (`scheme://host`) of an inbound request, used as
 * the dev fallback when no public origin is configured. Honours
 * `X-Forwarded-Proto` because the app runs behind a TLS-terminating reverse
 * proxy where `req.protocol` would read `http`. Returns `''` when the host is
 * unknown, so callers can detect an unresolvable origin.
 */
export const requestOrigin = (req: Request): string => {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(',')[0]?.trim();
  const scheme = proto || req.protocol || 'http';
  const host = req.get('host') ?? '';

  return host ? `${scheme}://${host}` : '';
};
