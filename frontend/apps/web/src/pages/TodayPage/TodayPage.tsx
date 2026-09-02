import { usePageTitle } from '@ci/common';

import { useFeatures } from '@/common/feature';
import { PageContent } from '@/components/layout';
import { SchedulePage } from '@/pages/SchedulePage';

/**
 * The calendar, full page.
 *
 * This used to also carry the Brief underneath (what your companion made of
 * the day, after what was planned for it) — split back out, so the calendar
 * is the only thing here and gets the whole page to scroll in rather than
 * being one card in a taller column.
 *
 * Forecast is deliberately NOT folded in. It is its own page and its own nav
 * entry, and it describes a horizon rather than a day, so it answers a
 * different question than this page does.
 *
 * `PageContent` carries no padding here — the calendar supplies its own
 * framing (a bordered, rounded card), and every pixel not spent on chrome is
 * a pixel of scrollable hours.
 *
 * "Calendar" rather than "Schedule": every link to this route already calls
 * it that, and `SchedulePage`'s own standalone title would say otherwise —
 * `embedded` is what keeps it quiet and lets this page's title stand.
 */
export function TodayPage() {
  usePageTitle('Calendar - Companion Intelligence');

  // `schedule.page` used to gate a whole route. It still has to gate the
  // schedule itself — with it off there is nothing left to show here.
  const { isFeatureEnabled } = useFeatures();
  const scheduleEnabled = isFeatureEnabled('schedule.page');

  return <PageContent className="p-0 gap-0">{scheduleEnabled && <SchedulePage embedded />}</PageContent>;
}
