import type { ReactNode } from 'react';

import DOMPurify from 'dompurify';
import parse, { Element, type HTMLReactParserOptions } from 'html-react-parser';

/**
 * The tags a message body keeps: text and its structure, nothing that loads,
 * submits or styles. A message is written by someone else, so its HTML is theirs.
 *
 * DOMPurify's `html` profile, which this replaces, keeps `<img>`, `<style>`,
 * `style=""` and `<form>`. A remote image (or a CSS `background`) tells the
 * sender when the message was opened and from which address, and a form can
 * pose as a sign-in box inside Memory.
 */
const MESSAGE_TAGS = [
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'code',
  'del',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
];

/** Links keep where they go, and nothing else: no `ping`, no `style`, no event handlers. */
const MESSAGE_ATTRIBUTES = ['href', 'title', 'colspan', 'rowspan'];

/** Web, mail and phone links. `javascript:`, `data:` and the rest are dropped with the attribute. */
const MESSAGE_LINK_SCHEMES = /^(?:https?:|mailto:|tel:)/i;

const parserOptions: HTMLReactParserOptions = {
  replace(node) {
    // Out of the app, and without telling the site which message the link was in.
    if (node instanceof Element && node.name === 'a') {
      node.attribs.target = '_blank';
      node.attribs.rel = 'noopener noreferrer nofollow';
    }

    return undefined;
  },
};

/** A message body's HTML, cut down to {@link MESSAGE_TAGS}, as text a card can show. */
export function sanitizeMessageHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: MESSAGE_TAGS,
    ALLOWED_ATTR: MESSAGE_ATTRIBUTES,
    // DOMPurify's own FORBID_CONTENTS stays in force: a `<style>` or `<script>` goes with what it holds.
    ALLOWED_URI_REGEXP: MESSAGE_LINK_SCHEMES,
  });
}

/** A message body rendered for a card: {@link sanitizeMessageHtml}, with links opening outside the app. */
export function renderMessageHtml(html: string): ReactNode {
  return parse(sanitizeMessageHtml(html), parserOptions);
}
