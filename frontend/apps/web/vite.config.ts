import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Load env variables from the root directory
  const env = loadEnv(mode, path.resolve(__dirname, '../../../'), '');

  // Extract domain from CI_SERVER_URL, fallback to default
  const serverUrl = env.CI_SERVER_URL || 'https://dev.companionintelligence.com';
  const serverDomain = new URL(serverUrl).hostname;

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 5173,
      allowedHosts: [serverDomain],
      fs: {
        allow: ['.', path.resolve(__dirname, '../../packages')],
      },
    },
    define: {
      // Expose environment variables to the client
      __CI_SERVER_URL__: JSON.stringify(serverUrl),
    },
  };
});
