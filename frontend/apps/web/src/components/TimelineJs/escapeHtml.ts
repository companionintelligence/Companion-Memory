import type { TimelineSlide } from './types';

/**
 * Plain text, made safe to hand to TimelineJS.
 *
 * TimelineJS reads a slide's `text.headline`, `text.text` and `media.caption`
 * as HTML and writes them with `innerHTML`. Its own DOMPurify pass removes
 * script but keeps `<style>`, `<img>` and `<form>`, and `TimelineJsHost` mounts
 * the timeline in the app's own document, so an email subject or a page title
 * carrying markup restyled the whole app and could fetch from any host. None of
 * these fields is meant to carry markup: they are subjects, titles, names and
 * places that other people wrote.
 *
 * Only `&`, `<` and `>` are escaped. Every place TimelineJS puts these strings
 * is element content, where quotes are inert, and leaving them alone keeps an
 * apostrophe in a title from turning into `&#39;` in the aria-label TimelineJS
 * builds from the headline.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (char) => (char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;'));
}

/** A slide's `text`, with both fields escaped by {@link escapeHtml}. */
export function plainSlideText(headline: string, text: string): TimelineSlide['text'] {
  return { headline: escapeHtml(headline), text: escapeHtml(text) };
}
