import type { Preview, StoryContext, StoryFn } from '@storybook/react';
import { MemoryRouter } from 'react-router-dom';

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
  (story: StoryFn, context: StoryContext) => <MemoryRouter>{story(context.args, context)}</MemoryRouter>,
];

export default preview;
