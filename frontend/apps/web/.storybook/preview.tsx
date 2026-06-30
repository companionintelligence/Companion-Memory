import type { Preview, StoryContext, StoryFn } from '@storybook/react';
import { MemoryRouter } from 'react-router-dom';

import { FeaturesProvider } from '@/common/feature';

import '../src/styles/index.css';

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
      <FeaturesProvider args={[]}>{story(context.args, context)}</FeaturesProvider>
    </MemoryRouter>
  ),
];

export default preview;
