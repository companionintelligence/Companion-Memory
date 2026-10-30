import { lazy, Suspense, type ReactNode } from 'react';

import { LoadingPage } from '@ci/common';
import { Navigate } from 'react-router-dom';

const AppearanceSection = lazy(() =>
  import('./sections/AppearanceSection').then((m) => ({ default: m.AppearanceSection })),
);
const PreferencesSection = lazy(() =>
  import('./sections/PreferencesSection').then((m) => ({ default: m.PreferencesSection })),
);
const AutonomySection = lazy(() =>
  import('./sections/AutonomySection').then((m) => ({ default: m.AutonomySection })),
);
const ModelSection = lazy(() => import('./sections/ModelSection').then((m) => ({ default: m.ModelSection })));
const OnDeviceModelSection = lazy(() =>
  import('./sections/OnDeviceModelSection').then((m) => ({ default: m.OnDeviceModelSection })),
);
const LocationSection = lazy(() =>
  import('./sections/LocationSection').then((m) => ({ default: m.LocationSection })),
);
const AppLockSection = lazy(() =>
  import('./sections/AppLockSection').then((m) => ({ default: m.AppLockSection })),
);
const SafariExtensionSection = lazy(() =>
  import('./sections/SafariExtensionSection').then((m) => ({ default: m.SafariExtensionSection })),
);
const BlueBubblesSection = lazy(() =>
  import('./sections/BlueBubblesSection').then((m) => ({ default: m.BlueBubblesSection })),
);
const McpSection = lazy(() => import('./sections/McpSection').then((m) => ({ default: m.McpSection })));
const AgentHarnessesSection = lazy(() =>
  import('./sections/AgentHarnessesSection').then((m) => ({ default: m.AgentHarnessesSection })),
);
const ApiKeysSection = lazy(() =>
  import('./sections/ApiKeysSection').then((m) => ({ default: m.ApiKeysSection })),
);
const OAuthSection = lazy(() => import('./sections/OAuthSection').then((m) => ({ default: m.OAuthSection })));
const PrivacySection = lazy(() =>
  import('./sections/PrivacySection').then((m) => ({ default: m.PrivacySection })),
);
const DataPortabilitySection = lazy(() =>
  import('./sections/DataPortabilitySection').then((m) => ({ default: m.DataPortabilitySection })),
);

function sectionElement(section: string): ReactNode {
  switch (section) {
    case 'appearance':
      return <AppearanceSection />;
    case 'preferences':
      return <PreferencesSection />;
    case 'autonomy':
      return <AutonomySection />;
    case 'model':
      return <ModelSection />;
    case 'on-device':
      return <OnDeviceModelSection />;
    case 'location':
      return <LocationSection />;
    case 'app-lock':
      return <AppLockSection />;
    case 'safari':
      return <SafariExtensionSection />;
    case 'bluebubbles':
      return <BlueBubblesSection />;
    case 'mcp':
      return <McpSection />;
    case 'agents':
      return <AgentHarnessesSection />;
    case 'api-keys':
      return <ApiKeysSection />;
    case 'oauth':
      return <OAuthSection />;
    case 'privacy':
      return <PrivacySection />;
    case 'data':
      return <DataPortabilitySection />;
    default:
      return null;
  }
}

/** One settings body, used by the desktop dialog and the mobile profile page. */
export function SettingsSectionBody({ section, fallbackTo }: { section: string; fallbackTo: string }) {
  const body = sectionElement(section);

  if (!body) {
    return <Navigate to={fallbackTo} replace />;
  }

  return <Suspense fallback={<LoadingPage />}>{body}</Suspense>;
}
