import path from 'node:path';

import dotenv from 'dotenv';

const envPath = process.env.DOTENV_CONFIG_PATH || '.env';

dotenv.config({ path: path.resolve(process.cwd(), envPath) });

// Derive OAuth callback URL from CI_SERVER_URL if not explicitly set
if (process.env.CI_SERVER_URL && !process.env.CI_SERVER_OAUTH_CALLBACK_URL) {
  const serverUrl = process.env.CI_SERVER_URL.replace(/\/$/, ''); // Remove trailing slash if present
  process.env.CI_SERVER_OAUTH_CALLBACK_URL = `${serverUrl}/oauth/callback`;
}
