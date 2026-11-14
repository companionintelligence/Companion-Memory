/**
 * An imported address as a web address, or null when it is not one.
 *
 * Imports store `ci.browser_activity.url` as NOT NULL, so a row with no page
 * behind it carries whatever the importer had instead. A search keeps its query.
 * A Google My Activity entry with only an action ("Explored on Google Maps",
 * "Dismissed shelf") keeps its title. A contact's website is kept as the card
 * had it, often a bare `www.example.com`. Rendered as `href`, such text resolved
 * against Memory's own origin and opened one of its pages in a new tab. Only
 * `http:` and `https:` are linked, which also keeps a `javascript:` value from an
 * imported file out of an anchor.
 *
 * Link to the returned URL's `href`, not the stored string. Parsed here with no
 * base, `https:www.example.com` is `https://www.example.com/`. In an anchor on a
 * page served over https the same string is a path on Memory's own origin.
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
