import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import type { StorybookConfig } from '@storybook/react-vite';

const require = createRequire(import.meta.url);

// Storybook 10 resolves the framework and every addon from its own package
// location, which declares none of them. Under Yarn PnP that is a hard error
// ("storybook tried to access @storybook/react-vite, but it isn't declared in
// its dependencies"), and the root-level devDependencies Storybook 9 leaned on
// as a fallback are gone. Resolve them from this workspace and hand Storybook
// absolute paths instead.
function getAbsolutePath(packageName: string): string {
  return dirname(require.resolve(`${packageName}/package.json`));
}

const config = {
  stories: ['../stories/**/*.stories.{ts,tsx}', '../src/**/*.stories.{ts,tsx}'],
  addons: [getAbsolutePath('@storybook/addon-docs'), getAbsolutePath('@storybook/addon-a11y')],
  framework: {
    name: getAbsolutePath('@storybook/react-vite'),
    options: {},
  },
} satisfies StorybookConfig;

export default config;
