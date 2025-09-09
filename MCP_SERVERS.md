# MCP Servers Setup Guide

This guide explains how to add, install, configure, and manage MCP (Model Context Protocol) servers for the CI-Server personal assistant system.

## Overview

The CI-Server integrates with external MCP servers to provide enhanced capabilities to the AI assistant. Currently supported servers:

- **Filesystem Server** - File operations (read, write, list directories, etc.)
- **Web Search Server** - Web search with content extraction
- **Custom Servers** - Any MCP-compatible server can be added

## Architecture

```
CI-Server (Yarn PnP)
├── MCP Host Service (manages server connections)
├── Tool Registry (unified tool management)
└── External MCP Servers (independent processes)
    ├── /some/directory/other/than/CI-Server/web-search-mcp/
    └── Other servers outside CI-Server directory
```

**Important:** MCP servers must be installed **outside** the CI-Server directory to avoid Yarn PnP dependency conflicts.

## Quick Start

### 1. Install an MCP Server

```bash
# Navigate to parent directory (outside Yarn PnP scope)

# Clone or download your MCP server
git clone https://github.com/mrkrsl/web-search-mcp.git
cd web-search-mcp

# Install dependencies
npm install

# Install required browsers (for web search server)
npx playwright install

# Build the server
npm run build
```

### 2. Configure the Server

Add the server configuration to `backend/apps/api/config/mcp-servers.json`:

```json
{
  "servers": {
    "your-server-name": {
      "name": "Your Server Display Name",
      "command": "node",
      "args": ["dist/index.js"],
      "workingDirectory": "<your-server-directory>",
      "enabled": true,
      "description": "Description of what this server does",
      "timeout": 60000,
      "healthCheck": {
        "enabled": true,
        "intervalMs": 120000,
        "timeoutMs": 20000,
        "retryCount": 2,
        "restartOnFailure": true
      }
    }
  }
}
```

### 3. Restart CI-Server

```bash
cd CI-Server
yarn workspace @ci/be-api dev
```

### 4. Verify Installation

```bash
# Check if tools are registered
curl http://localhost:3030/mcp/debug/tools

# Check server health
curl http://localhost:3030/mcp/health
```

## Detailed Installation Guide

### Installing the Web Search Server (Example)

```bash
# 1. Navigate outside CI-Server directory

# 2. Clone the repository
git clone https://github.com/mrkrsl/web-search-mcp.git
cd web-search-mcp

# 3. Install dependencies
npm install

# 4. Install Playwright browsers (required for web scraping)
npx playwright install

# 5. Build the TypeScript project
npm run build

# 6. Test the server manually (optional)
node dist/index.js
# Should show: "Web Search MCP Server started"
# Press Ctrl+C to stop

# 7. Configure in CI-Server (see Configuration section below)
```

### Installing Other MCP Servers

The process is similar for any MCP server:

```bash
# Example: PostgreSQL MCP server
git clone https://github.com/modelcontextprotocol/servers.git mcp-servers-official
cd mcp-servers-official/src/postgres

# Install and build
npm install
npm run build

# Configure in mcp-servers.json with appropriate connection settings
```

## Configuration Reference

### Basic Server Configuration

```json
{
  "servers": {
    "server-id": {
      "name": "Human-readable server name",
      "command": "node|python|executable",
      "args": ["script.js", "--arg1", "value"],
      "workingDirectory": "/absolute/path/to/server",
      "enabled": true|false,
      "description": "What this server provides",
      "timeout": 30000,
      "environment": {
        "ENV_VAR": "value"
      },
      "healthCheck": {
        "enabled": true,
        "intervalMs": 30000,
        "timeoutMs": 5000,
        "retryCount": 3,
        "restartOnFailure": true
      }
    }
  }
}
```

### Configuration Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | string | Yes | Display name for the server |
| `command` | string | Yes | Executable command (node, python, etc.) |
| `args` | array | No | Arguments to pass to the command |
| `workingDirectory` | string | Recommended | Absolute path to server directory |
| `enabled` | boolean | Yes | Whether to start this server |
| `timeout` | number | No | Connection timeout in milliseconds |
| `environment` | object | No | Environment variables for the server |
| `healthCheck` | object | No | Health monitoring configuration |

### Example Configurations

#### Web Search Server
```json
{
  "web-search": {
    "name": "Web Search Engine",
    "command": "node",
    "args": ["dist/index.js"],
    "workingDirectory": "<web-search-mcp folder>",
    "enabled": true,
    "description": "Multi-engine web search with content extraction",
    "timeout": 60000,
    "healthCheck": {
      "enabled": true,
      "intervalMs": 120000,
      "timeoutMs": 20000,
      "retryCount": 2,
      "restartOnFailure": true
    }
  }
}
```

#### PostgreSQL Server
```json
{
  "postgres": {
    "name": "Database Access",
    "command": "node",
    "args": ["dist/index.js"],
    "workingDirectory": "<mcp-postgres-server>",
    "enabled": true,
    "description": "Direct PostgreSQL database access",
    "timeout": 30000,
    "environment": {
      "POSTGRES_CONNECTION_STRING": "postgresql://user:pass@localhost:5432/db"
    }
  }
}
```

#### Python MCP Server
```json
{
  "python-tools": {
    "name": "Python Data Tools",
    "command": "python3",
    "args": ["-m", "my_mcp_server"],
    "workingDirectory": "<python-mcp-tools dir>",
    "enabled": true,
    "description": "Python-based data analysis tools",
    "timeout": 45000,
    "environment": {
      "PYTHONPATH": "<python-mcp-tools>"
    }
  }
}
```

## Creating Custom MCP Servers

### Basic MCP Server Structure

```javascript
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

class CustomMCPServer {
  constructor() {
    this.server = new McpServer({
      name: 'custom-mcp-server',
      version: '1.0.0',
    });

    this.setupTools();
    this.setupGracefulShutdown();
  }

  setupTools() {
    // Register your tools here
    this.server.tool(
      'example-tool',
      'Description of what this tool does',
      {
        input: z.string().describe('Input parameter description'),
      },
      async (args) => {
        // Tool implementation
        return { result: `Processed: ${args.input}` };
      }
    );
  }

  setupGracefulShutdown() {
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

const server = new CustomMCPServer();
server.run().catch(console.error);
```

### Package.json for Custom Server

```json
{
  "name": "my-custom-mcp-server",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "bin": {
    "my-custom-mcp": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "start": "node ./dist/index.js",
    "dev": "tsx watch src/index.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.17.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0",
    "tsx": "^4.0.0"
  }
}
```

## Troubleshooting

### Common Issues

#### 1. "Connection closed" Error
**Cause:** Server process exits immediately after starting.

**Solutions:**
- Check if the server has all required dependencies installed
- Verify the working directory path is correct
- Ensure the server is built (`npm run build`)
- Check server logs for specific error messages

#### 2. Yarn PnP Dependency Conflicts
**Cause:** Server is installed inside CI-Server directory.

**Solution:** 
```bash
# Move server outside CI-Server directory
mv CI-Server/problematic-server ../
# Update workingDirectory in mcp-servers.json
```

#### 3. Tools Not Appearing in LLM
**Causes:**
- Server is disabled (`"enabled": false`)
- Server failed to start
- Tools not properly registered

**Debug Steps:**
```bash
# Check server status
curl http://localhost:3030/mcp/health

# Check registered tools
curl http://localhost:3030/mcp/debug/tools

# Check CI-Server logs for error messages
```

#### 4. Server Won't Start
**Common causes:**
- Missing dependencies: `npm install`
- Missing build: `npm run build`
- Wrong Node.js version
- Missing environment variables
- Permission issues

### Debug Commands

```bash
# Test server manually
cd /path/to/mcp-server
node dist/index.js

# Check CI-Server logs
tail -f /path/to/ci-server/logs

# Test MCP endpoints
curl http://localhost:3030/mcp/sessions
curl http://localhost:3030/mcp/tools
curl http://localhost:3030/mcp/debug/tools
```

### Environment Variables

Some servers require environment variables:

```bash
# For database servers
export DATABASE_URL="postgresql://user:pass@localhost:5432/db"

# For API-based servers
export API_KEY="your-api-key"
export API_BASE_URL="https://api.example.com"

# Add to CI-Server environment or server config
```

## Best Practices

### 1. Server Organization
```

─ CI-Server/                    # Main application
├── web-search-mcp/              # Web search server
├── postgres-mcp/                # Database server
├── custom-tools-mcp/            # Custom tools
└── third-party-mcp-servers/     # Other MCP servers
```

### 2. Development Workflow
```bash
# 1. Develop server outside CI-Server
cd /some/non/CI-Server/repo/my-new-server

# 2. Test server independently
npm run dev

# 3. Build for production
npm run build

# 4. Add to CI-Server config
# Edit backend/apps/api/config/mcp-servers.json

# 5. Test integration
curl http://localhost:3030/mcp/debug/tools
```

### 3. Configuration Management
- Keep server configs in version control
- Use environment variables for secrets
- Document required environment variables
- Test with `"enabled": false` first

### 4. Error Handling
- Always implement graceful shutdown
- Add comprehensive error logging
- Use appropriate timeout values
- Implement health checks for critical servers

## Available MCP Servers

### Official Servers
- **Filesystem** - File operations (built-in)
- **PostgreSQL** - Database access
- **SQLite** - Local database operations
- **Brave Search** - Web search via Brave API
- **GitHub** - Repository management
- **Google Drive** - File management
- **Slack** - Team communication

### Community Servers
- **Web Search** - Multi-engine search with content extraction
- **Notion** - Workspace management
- **Jira** - Issue tracking
- **Docker** - Container management
- **AWS** - Cloud services

### Finding More Servers
- [MCP Servers Repository](https://github.com/modelcontextprotocol/servers)
- [Awesome MCP](https://github.com/punkpeye/awesome-mcp-servers)
- [MCP Community](https://github.com/topics/mcp-server)

## Security Considerations

### 1. Sandbox Restrictions
- Filesystem server: Limited to `/tmp` directory
- Network access: Configure firewall rules
- Environment isolation: Use separate user accounts

### 2. Access Control
- Review server capabilities before enabling
- Monitor server resource usage
- Implement logging for security auditing

### 3. Data Privacy
- Understand what data each server accesses
- Configure appropriate data retention policies
- Review third-party server privacy policies

## Support

### Getting Help
1. Check server documentation/README
2. Review CI-Server logs for error messages
3. Test server independently outside CI-Server
4. Check MCP protocol compatibility
5. Verify environment and dependencies

### Contributing
To add a new server type to this guide:
1. Follow the installation process
2. Document any special requirements
3. Add configuration examples
4. Update troubleshooting section

---

**Last Updated:** January 2025
**Compatible with:** CI-Server v1.0+, MCP SDK v1.17+
