import { useState, type ReactNode } from 'react';

import { Badge, Button, Card } from '@ci/shadcn';
import { AlertTriangle, ExternalLink } from '@ci/shadcn/icons';

import { Markdown } from '@/components/Markdown';

import type { ImportSourceGuide } from './useImportApi';
import { shortTitle } from './wizard/sources';

export interface SourceGuideProps {
  guide: ImportSourceGuide;
  /** The service's brand logo URL, when one exists. Hidden if it fails to load. */
  logo?: string | null;
  /** Extra badges beside the wait class — "files staged ✓", "coming soon". */
  badges?: ReactNode;
  /**
   * Rendered inside the card, after the instructions. The wizard's export card
   * puts its upload area here so the drop target and the steps that lead to it
   * are one surface.
   */
  children?: ReactNode;
}

/** How long the service takes to hand the export over, in words. */
const WAIT_LABELS: Record<string, string> = {
  instant: 'Available immediately',
  minutes: 'Ready in minutes',
  hours: 'Ready in a few hours',
  days: 'Takes a day or more',
  weeks: 'Can take weeks',
};

/**
 * Upstream's traffic light, in this repo's palette: quick waits green, a day
 * or more amber, weeks red — white text on all three. The chip is the single
 * most useful fact on the card ("Spotify can take 30 days"), which is why it
 * gets color where every other chip stays an outline.
 */
const WAIT_BADGE_CLASSES: Record<string, string> = {
  instant: 'border-transparent bg-emerald-500 text-white',
  minutes: 'border-transparent bg-emerald-500 text-white',
  hours: 'border-transparent bg-amber-500 text-white',
  days: 'border-transparent bg-amber-500 text-white',
  weeks: 'border-transparent bg-red-500 text-white',
};

/** How the export is obtained, in words. Unknown kinds render as authored. */
const ACQUISITION_LABELS: Record<string, string> = {
  'web-export': 'Web export',
  'app-export': 'App export',
  'local-file': 'Local file',
  'manual-upload': 'Manual upload',
  'one-download': 'One download',
  api: 'API',
};

/**
 * How to get one export out of the service that holds it.
 *
 * Rendered inline, next to the source someone just picked, because that is the
 * moment the question is asked. Sending them to a documentation page to find out
 * where Google keeps the Takeout button is how people give up on an import.
 *
 * The wait class is shown prominently for the same reason: "Spotify can take up
 * to 30 days" is the single most useful thing to know BEFORE starting, and
 * discovering it after clicking through five settings pages is a bad surprise.
 */
export function SourceGuide({ guide, logo, badges, children }: SourceGuideProps) {
  const [logoFailed, setLogoFailed] = useState(false);

  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-start gap-3">
        {logo != null && !logoFailed ? (
          <img
            src={logo}
            alt=""
            className="mt-0.5 h-8 w-8 shrink-0 object-contain"
            onError={() => setLogoFailed(true)}
          />
        ) : null}

        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="font-medium">{guide.title}</h3>
          <p className="text-sm text-muted-foreground">{guide.blurb}</p>
        </div>

        {/* Pinned to the card's upper right: the chips answer "how long, and
            how?" at a glance, before anyone reads a word of the steps. */}
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Badge variant="outline" className={WAIT_BADGE_CLASSES[guide.wait]}>
            {WAIT_LABELS[guide.wait] ?? guide.wait}
          </Badge>
          {guide.acquisition ? (
            <Badge variant="outline">{ACQUISITION_LABELS[guide.acquisition] ?? guide.acquisition}</Badge>
          ) : null}
          {badges}
        </div>
      </div>

      {/* One wrapper for the steps AND their button, exactly like the alt
          path below: as separate flex items they would sit a card gap apart
          (the shared Card's gap-6 plus this card's space-y margins), which
          visually orphans the button from the instructions it concludes. */}
      <div className="space-y-3">
        <Steps title={guide.stepsTitle ?? 'How to export'} steps={guide.steps} />

        {guide.url ? (
          // Below the steps, as upstream places it: the instructions explain
          // what the page will ask, so the button is the last thing read, not
          // the first thing clicked.
          <ExportCta url={guide.url} label={`Open the ${shortTitle(guide.title)} export page`} />
        ) : null}
      </div>

      {guide.altPath ? (
        <div className="space-y-3">
          <Steps title={guide.altPath.title} steps={guide.altPath.steps} />
          {guide.altPath.url ? (
            <ExportCta url={guide.altPath.url} label={`Open the ${shortTitle(guide.title)} export page`} />
          ) : null}
        </div>
      ) : null}

      {guide.expectedFormat ? (
        <section className="space-y-1">
          <h4 className="text-sm font-medium">Expected format</h4>
          <div className="text-sm text-muted-foreground">
            <Markdown>{guide.expectedFormat}</Markdown>
          </div>
        </section>
      ) : null}

      {guide.whatImported?.length ? (
        <section className="space-y-1">
          <h4 className="text-sm font-medium">What this brings in</h4>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
            {guide.whatImported.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {guide.caveats?.length ? (
        <section className="space-y-1">
          <h4 className="flex items-center gap-1 text-sm font-medium">
            <AlertTriangle className="h-3 w-3 text-amber-500" aria-hidden />
            Worth knowing first
          </h4>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
            {guide.caveats.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {guide.notes?.length ? (
        // Headingless, as upstream: these are asides, not a section anyone
        // scans for.
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
          {guide.notes.map((note) => (
            <li key={note}>
              <Markdown>{note}</Markdown>
            </li>
          ))}
        </ul>
      ) : null}

      {children}
    </Card>
  );
}

/**
 * The named doorway to the service's own export flow, styled as a real button.
 *
 * Primary, matching the step's other main action ("Finish → Sync") — opening
 * the export page IS the main thing this card asks the reader to do. And
 * `self-start`, because the guide card is a flex column whose items stretch
 * across the cross axis by default: without it the button spans the card
 * instead of hugging its label.
 */
function ExportCta({ url, label }: { url: string; label: string }) {
  return (
    <Button asChild className="self-start">
      <a href={url} target="_blank" rel="noreferrer">
        {label}
        <ExternalLink aria-hidden />
      </a>
    </Button>
  );
}

function Steps({ title, steps }: { title: string; steps: readonly string[] }) {
  return (
    <section className="space-y-1">
      <h4 className="text-sm font-medium">{title}</h4>

      {/* Chat markdown gets its link colour from a `prose` wrapper; this list
          has none, so a link in a step would read as ordinary grey text.
          Blue, underlined, darker on hover: the one look everyone reads as
          "click me". The links open in a new tab, so the step list they are
          reading stays where it is. */}
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground [&_a]:text-blue-600 [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:text-blue-800 dark:[&_a]:text-blue-400 dark:[&_a:hover]:text-blue-300">
        {steps.map((step) => (
          // The steps are AUTHORED as inline markdown — nested per-OS bullets
          // joined with newlines, backticked paths — and rendering them as
          // plain text is how `**Windows:**` reaches someone's screen verbatim.
          <li key={step}>
            <Markdown linkTarget="_blank">{step}</Markdown>
          </li>
        ))}
      </ol>
    </section>
  );
}
