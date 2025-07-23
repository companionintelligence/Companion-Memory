import path from 'node:path';

import dotenv from 'dotenv';

const envPath = process.env.DOTENV_CONFIG_PATH || '.env';

dotenv.config({ path: path.resolve(process.cwd(), envPath) });
