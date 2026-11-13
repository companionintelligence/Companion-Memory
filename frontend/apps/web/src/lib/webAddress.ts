/**
 * An imported address as a web address, or null when it is not one.
 *
 * Imports store `ci.browser_activity.url` as NOT NULL, so a row with no page
 * behind it carries whatever the importer had instead: a search keeps its query,
 * and a Google My Activity entry with only an action ("Explored on Google Maps",
 * "Dismissed shelf") keeps its title. A contact's website is kept as the card
 * had it, often a bare `www.example.com`. Rendered as `href`, such text resolved
 * against Memory's own origin and opened one of its pages in a new tab. Only
 * `http:` and `https:` are linked, which also keeps a `javascript:` value from an
 * imported file out of an anchor.
 */
export function webAddress(url: string | null | undefined): URL | null {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);

    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}
