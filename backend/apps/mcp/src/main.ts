import { createDefaultApp } from './server';
import { readMcpConfig } from './config';

const app = createDefaultApp();
const mcpConfig = readMcpConfig();

app.listen(mcpConfig.CI_MCP_PORT, (error?: Error) => {
  if (error) {
    console.error('Failed to start ci-mcp', error);
    process.exit(1);
  }

  console.log(`ci-mcp listening on port ${mcpConfig.CI_MCP_PORT}`);
});
