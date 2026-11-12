import type { ToolResult } from '../core/types';

/**
 * A result whose hit links (`items[].link`, from the search intents' `itemLink`)
 * are made absolute against the app's public origin.
 *
 * Those links are site-relative (`/content/<id>`), which is right for the app's
 * own chat: it renders them on its own origin. A Hub agent (OpenClaw, Hermes)
 * is served from a different origin, so its model completed the path with the
 * only host it knew, its own: `https://ci-openclaw-…/content/<id>`, which opens
 * OpenClaw's "This shared session route is unavailable" page instead of the
 * photo. Seen 2026-11-11 on a "latest photo of a cat, with link" request.
 *
 * Applied where a caller from another origin gets results: the REST intent
 * route (every caller), and MCP for any key but a signed-in app's. The phone's
 * on-device model reaches intents over MCP, never shows a link, and fits its
 * results into a 1k-4k window, so it keeps the shorter path.
 *
 * Leaves the result as it was when no public origin is configured (a plain
 * `make dev` sets none) or a link is anything but a site-relative path.
 */
export function withAbsoluteItemLinks(result: ToolResult, publicBaseUrl: string | undefined): ToolResult {
  const base = publicBaseUrl?.trim().replace(/\/+$/, '');
  const data = result.data as { items?: unknown } | null | undefined;

  if (!base || !data || typeof data !== 'object' || !Array.isArray(data.items)) {
    return result;
  }

  const items = data.items.map((item: unknown) => {
    const link = (item as { link?: unknown } | null)?.link;

    // `//host/...` is protocol-relative, not a path on this site.
    return typeof link === 'string' && link.startsWith('/') && !link.startsWith('//')
      ? { ...(item as object), link: `${base}${link}` }
      : item;
  });

  return { ...result, data: { ...data, items } };
}
