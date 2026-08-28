import { useCallback, useState } from 'react';

import { ImportSurface, type ImportStage } from '@/pages/ImportPage/ImportPage';

import { StepHeader } from './StepHeader';

/**
 * What the one heading on the screen says, per phase of the import.
 *
 * The wizard's own stepper is hidden here (see `ImportSurface`'s onboarding
 * variant), because onboarding already has a step indicator and a
 * Back/Skip/Next footer — two steppers is two answers to "where am I". So the
 * phase is narrated instead: the heading is the progress.
 *
 * Only the first phase mentions skipping. An export is a download Google can
 * take days to produce, so most people arrive here with nothing to give it and
 * need to hear that is fine — but once someone has picked a service and is
 * following instructions, repeating "you can skip" every screen reads as
 * hurrying them out.
 */
const HEADINGS: Record<ImportStage, { title: string; description: string }> = {
  pick: {
    title: 'Bring in an export',
    description:
      'Already downloaded your data from Google, Apple or anywhere else? Add it now. No export yet? Skip — you can import any time.',
  },
  export: {
    title: 'Export your data',
    description:
      'Follow the steps for each service, then drop the file or folder it gives you onto the card.',
  },
  sync: {
    title: 'Add it to your memory',
    description: 'Everything you uploaded is staged and ready. This puts it into your timeline.',
  },
};

/**
 * Bring in an export you already have — an optional step of its own.
 *
 * Importing used to be one card among ten on the connect step, opening a
 * dialog. That put the single richest source of memory a new user has behind a
 * control most people never noticed: connecting Gmail seeds the last weeks,
 * while a Google Takeout seeds the last decade.
 *
 * A step, not a gate. Onboarding's footer renders Skip on every step and says
 * so, and this leans on that rather than inventing a second escape hatch.
 *
 * The surface is the same one `/import` hosts, so the two cannot drift — only
 * its chrome differs: no tab bar and no inner stepper, leaving a single linear
 * flow inside a single set of steps.
 */
export function ImportArchivesStep() {
  const [stage, setStage] = useState<ImportStage>('pick');
  // Identity-stable so the surface's effect does not re-fire every render.
  const handleStage = useCallback((next: ImportStage) => setStage(next), []);
  const heading = HEADINGS[stage];

  return (
    <div className="mx-auto w-full space-y-4">
      <StepHeader title={heading.title} description={heading.description} />

      {/* `text-left` undoes the step wrapper's `text-center`, which onboarding
          applies to every step. Centering is right for a typeform-style
          question — it is wrong for an application surface, where it centred
          the export guide's numbered instructions, the service cards and the
          form controls inside them.
          No nested scroller: the onboarding page is the only overflow-y-auto,
          so Capture-style source lists and this catalog share one scrollbar,
          with Next after the content. */}
      <div className="w-full text-left">
        <ImportSurface variant="onboarding" onStageChange={handleStage} />
      </div>

      <p className="text-center text-sm text-muted-foreground">
        Imports keep running after setup finishes — you don&rsquo;t have to wait here.
      </p>
    </div>
  );
}
