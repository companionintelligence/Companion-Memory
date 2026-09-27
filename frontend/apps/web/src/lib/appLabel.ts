/**
 * Human-readable names for the installed apps that can act on the owner's behalf.
 *
 * Shared by the {@link ApprovalCard} (which asks "OpenClaw wants to send a
 * message — allow it?") and the Activity page (which reports what it did), so an
 * app is named the same way in the question and in the record. The same
 * reasoning as {@link sourceNames}: two hand-kept maps is how the two surfaces
 * come to disagree about what to call the same thing.
 *
 * The wire value is an api-key name — `app:ci-openclaw:ci-marketplace` — because
 * that is the FACT the row stores. Presentation is deliberately not stored: the
 * backend's harness display registry lives in `domains/persona`, which
 * `domains/tools` may not reach into (`no-cross-domain-internals`), and a label
 * frozen into a year-old ledger row would be wrong the first time an app is
 * renamed.
 */
const APP_LABELS: Readonly<Record<string, string>> = {
  'ci-openclaw': 'OpenClaw',
  'ci-hermes': 'Hermes',
  'ci-mentra': 'Mentra glasses',
};

/**
 * Name the app that asked, or `null` when it was the owner themselves.
 *
 * The FALLBACK is the load-bearing part, not the map. A newly installed app must
 * be nameable on a card the day it ships: `ci-something` is a worse label than
 * `OpenClaw` and a far better one than a blank badge or a raw urn. So an
 * unrecognised slug is returned as the slug, and only a value that does not
 * parse as an app urn at all is passed through verbatim.
 *
 * `null` in, `null` out — and callers render that as "You". Not every action has
 * an app behind it: the owner's own trust dial still queues calls, and a card
 * reading "OpenClaw" for one of those would be a lie about provenance.
 */
export function appLabel(principalName: string | null | undefined): string | null {
  if (!principalName) {
    return null;
  }

  // `app:<slug>:<marketplace>` — the slug is the app.
  const slug = principalName.startsWith('app:') ? principalName.slice(4).split(':')[0] : null;

  if (!slug) {
    return principalName;
  }

  return APP_LABELS[slug] ?? slug;
}
