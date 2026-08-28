import { LoadingPage } from '@ci/common';
import { Navigate, Route, Routes } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { ProfilePage } from '@/pages/ProfilePage/ProfilePage';
import { PromptsPage } from '@/pages/PromptsPage/PromptsPage';
import { StatsPage } from '@/pages/StatsPage/StatsPage';

import { SelfProfileTab } from './SelfProfileTab';

/**
 * You, in one place: identity (name, birthday, gender, about — the same
 * Person editor used elsewhere in the graph, pointed at your own entity),
 * what Companion has learned about you, account deletion, life stats, and
 * reflections. Folds together the former `/settings/about-you`,
 * `/settings/account`, `/stats`, `/memory/reflections`, and the phone
 * `/profile` settings hub (`/self/settings`). Navigated entirely from the
 * Power Rail's Self user tile — no in-page tab bar of its own.
 */
export function SelfPage() {
  const { isFeatureEnabled, loading: featuresLoading } = useFeatures();

  return (
    <div className="h-full min-h-0">
      <Routes>
        <Route index element={<SelfProfileTab />} />
        <Route path="stats" element={<StatsPage />} />
        {isFeatureEnabled('insights.page') && <Route path="reflections" element={<PromptsPage />} />}
        <Route path="settings/*" element={<ProfilePage />} />
        {/* `isFeatureEnabled` reports every flag as off until both flag sets
            have settled, so `reflections` is genuinely absent from the table
            for the first frames after this mounts. Redirecting on that would
            bounce anyone opening /self/reflections — a cold start, a deep
            link, or the phone restoring its last route — back to /self with
            `replace`, losing the destination before the flags ever arrive.
            Same wait App's own catch-all does, and the reason `loading`
            exists (see useFeatures). */}
        <Route
          path="*"
          element={featuresLoading ? <LoadingPage /> : <Navigate to="/self" replace />}
        />
      </Routes>
    </div>
  );
}
