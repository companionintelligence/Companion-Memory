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
    // DOMPurify keeps these however short the list above is, and the app's own CSS acts on them: a
    // toast's `data-sonner-*` pins the element over the whole app.
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    // DOMPurify's own FORBID_CONTENTS stays in force: a `<style>` or `<script>` goes with what it holds.
    ALLOWED_URI_REGEXP: MESSAGE_LINK_SCHEMES,
  });
}

/** A message body rendered for a card: {@link sanitizeMessageHtml}, with links opening outside the app. */
export function renderMessageHtml(html: string): ReactNode {
  return parse(sanitizeMessageHtml(html), parserOptions);
}

/**
 * Whether a stored message body is HTML: a document or markup an email client wrote, not a text
 * message or a `text/plain` email that happens to mention `<3` or `a < b`.
 *
 * The tag name has to end where it ends, so `<p.smith@example.com>` is an address. A match stops at
 * the next `<`, which keeps a long run of unclosed tags linear.
 */
export function isHtmlMessageBody(body: string): boolean {
  return /<(?:!doctype\s+html|(?:html|head|body|div|p|br|table|span|a|strong|em|b|i|ul|ol|li|h[1-6])(?=[\s/>]))[^<>]*>/i.test(
    body,
  );
}

/**
 * A message body as a reader sees it. HTML is cleaned ({@link sanitizeMessageHtml}) and rendered, with
 * links opening outside the app. Plain text keeps its line breaks. Shown raw, an email's HTML read as
 * a page of markup, and its first characters were all `<head>`.
 */
export function renderMessageBody(body: string): ReactNode {
  if (!isHtmlMessageBody(body)) {
    return <span className="whitespace-pre-wrap break-words">{body}</span>;
  }

  return (
    <div className="message-body break-words [&_a]:underline [&_a]:text-primary">
      {renderMessageHtml(body)}
    </div>
  );
}

/** How much of a text message a card shows. */
const CARD_TEXT_LIMIT = 1000;

/**
 * The body a card renders: an HTML email whole (the card clips it by height), and a text message cut
 * short. Cutting HTML first left the card blank: an email's first thousand characters are its <head>,
 * which cleans to nothing.
 */
export function cardMessageBody(body: string): string {
  if (isHtmlMessageBody(body) || body.length <= CARD_TEXT_LIMIT) {
    return body;
  }

  return `${body.substring(0, CARD_TEXT_LIMIT)}...`;
}
