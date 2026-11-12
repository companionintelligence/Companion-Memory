import { useEffect } from 'react';

import { addAppUrlOpenListener, getLaunchUrl, parseWidgetDestination } from '@ci/common';
import { useNavigate } from 'react-router-dom';

import { useFeatures } from '@/common/feature';

/** Turns the widget's fixed custom-scheme destinations into app routes. */
export function WidgetDeepLinkRouter() {
  const navigate = useNavigate();
  const { isFeatureEnabled } = useFeatures();

  useEffect(() => {
    let disposed = false;
    const open = (rawUrl: string) => {
      if (disposed) return;
      const destination = parseWidgetDestination(rawUrl);

      if (destination === 'plan') {
        navigate(isFeatureEnabled('planning.page') ? '/plan/tasks' : '/plan/calendar');
      } else if (destination === 'ask' || destination === 'questions') {
        navigate(isFeatureEnabled('chat.page') ? '/chat' : '/search');
      } else if (destination === 'stats') {
        navigate('/memory');
      } else if (destination === 'jobs') {
        navigate(isFeatureEnabled('jobs.page') ? '/jobs' : '/settings');
      }
    };

    // Register before reading the cold-start URL so a live event cannot race the read.
    let removeListener: (() => void) | undefined;
    void addAppUrlOpenListener(open).then((remove) => {
      removeListener = remove;
    });
    void getLaunchUrl().then((url) => {
      if (url) open(url);
    });

    return () => {
      disposed = true;
      removeListener?.();
    };
  }, [isFeatureEnabled, navigate]);

  return null;
}
