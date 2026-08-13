import { DeviceLayoutProvider } from '@ci/common';
import type { Preview, StoryContext, StoryFn } from '@storybook/react';
import { MemoryRouter } from 'react-router-dom';

import { FeaturesProvider } from '@/common/feature';
import { AuthProvider } from '@/hooks';
import { initI18n } from '@/lib/i18n';

import '../src/styles/index.css';

// Without this, react-i18next hands back a no-op `t` that returns the key, so
// every story renders raw KEY strings as tooltip text and accessible names —
// which the a11y addon then audits.
initI18n();

const preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },

    a11y: {
      test: 'todo',
    },
  },
} satisfies Preview;

export const decorators = [
  (story: StoryFn, context: StoryContext) => (
    <MemoryRouter>
      <AuthProvider args={[]}>
        {/* Mirrors App.tsx: anything calling `useDeviceLayout` (BentoCard and every
            card built on it) throws "must be used within the associated Provider"
            without this, so the stories rendered as an error panel. */}
        <DeviceLayoutProvider args={[]}>
          <FeaturesProvider args={[]}>{story(context.args, context)}</FeaturesProvider>
        </DeviceLayoutProvider>
      </AuthProvider>
    </MemoryRouter>
  ),
];

export default preview;
