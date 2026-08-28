import { usePageTitle } from '@ci/common';

import { useFeatures } from '@/common/feature';
import { PageContent } from '@/components/layout';
import FeedPage from '@/pages/FeedPage';
import { SchedulePage } from '@/pages/SchedulePage';

/**
 * Your day, in one place: what is planned, then what your companion made of it.
 *
 * Schedule and Brief answered two halves of the same question — "what is
 * happening" and "what does it mean" — from two destinations, so the answer was
 * something you assembled by navigating. They are one page now, in that order:
 * the schedule leads because it is the part with a time on it and the part you
 * act against, and the brief follows because it is commentary ON the day rather
 * than the day itself.
 *
 * Forecast is deliberately NOT folded in. It is its own page and its own nav
 * entry, and it describes a horizon rather than a day, so it answers a third
 * question — one this page does not claim to.
 *
 * Composed from the two page components rather than a copy of their contents,
 * in their `embedded` variant — the same idiom `ImportSurface` uses. Each keeps
 * its own data fetching and its own standalone route; embedded, they drop the
 * two things this page owns, the document title and the PageContent frame.
 * PageContent is the scroll container, so nesting it would give the screen two
 * scrollbars and two sets of padding.
 *
 * "Calendar" rather than "Home": the page opens on a schedule that already
 * carries date navigation, so the name stays true when you page to another
 * week, and it says what you will find rather than where you are in the app.
 */
export function TodayPage() {
  usePageTitle('Calendar - Companion Intelligence');

  // `schedule.page` used to gate a whole route. It still has to gate the
  // schedule itself, or turning the flag off would quietly stop hiding it —
  // with the flag off this page is the brief alone, which is what it was.
  const { isFeatureEnabled } = useFeatures();
  const scheduleEnabled = isFeatureEnabled('schedule.page');

  return (
    <PageContent className="md:pt-[max(0.75rem,env(safe-area-inset-top))]">
      {scheduleEnabled && (
        <>
          <SchedulePage embedded />

          {/* A rule, not a heading. The seam between "your day" and "what your
              companion noticed" needs to be visible — otherwise the first card
              of the brief reads as another row of the calendar — but naming it
              would add a piece of furniture to a page that exists to remove
              one. It goes with the schedule: a rule above the only thing on
              the page separates it from nothing. */}
          <hr className="border-border" />
        </>
      )}

      <FeedPage embedded />
    </PageContent>
  );
}
