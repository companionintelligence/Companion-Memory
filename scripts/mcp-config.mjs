#!/usr/bin/env node

/**
 * Enhanced MCP Configuration Manager
 * - Creates config file if it doesn't exist
 * - Uses dynamic paths (no hardcoded user directories)
 * - Automatically registers servers during installation
 * - Supports portable setup across different machines
 */

import fs from 'fs';
import path from 'path';

const CONFIG_FILE = 'backend/apps/api/config/mcp-servers.json';
const CONFIG_DIR = path.dirname(CONFIG_FILE);
const BACKUP_SUFFIX = '.backup';

// Default configuration template
const DEFAULT_CONFIG = {
  servers: {},
};

// Server templates with dynamic path resolution
const SERVER_TEMPLATES = {
  filesystem: {
    name: 'File System Access',
    command: 'npx',
    args: ['--yes', '@modelcontextprotocol/server-filesystem', '/tmp'],
    enabled: false,
    description: 'Provides file system operations for the assistant',
    timeout: 30000,
    healthCheck: {
      enabled: true,
      intervalMs: 30000,
      timeoutMs: 5000,
      retryCount: 3,
      restartOnFailure: true,
    },
  },
  'web-search': {
    name: 'Web Search Engine',
    command: 'node',
    args: ['dist/index.js'],
    enabled: false,
    description: 'Multi-engine web search with content extraction',
    timeout: 60000,
    healthCheck: {
      enabled: false,
      intervalMs: 120000,
      timeoutMs: 20000,
      retryCount: 2,
      restartOnFailure: true,
    },
  },
};

function createConfigDirectory() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    console.log(`✓ Created config directory: ${CONFIG_DIR}`);
  }
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    console.log(`ℹ Creating new configuration file: ${configPath}`);
    createConfigDirectory();
    saveConfig(configPath, DEFAULT_CONFIG);

    return DEFAULT_CONFIG;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf8');

    return JSON.parse(content);
  } catch (error) {
    console.error(`✗ Error reading config file: ${error.message}`);
    console.log(`ℹ Creating backup and new config file`);

    // Create backup of corrupted file
    const backupPath = `${configPath}.corrupted.${Date.now()}`;
    fs.copyFileSync(configPath, backupPath);
    console.log(`ℹ Corrupted config backed up to: ${backupPath}`);

    saveConfig(configPath, DEFAULT_CONFIG);

    return DEFAULT_CONFIG;
  }
}

function saveConfig(configPath, config) {
  createConfigDirectory();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function createBackup(configPath) {
  if (fs.existsSync(configPath)) {
    const backupPath = configPath + BACKUP_SUFFIX;
    fs.copyFileSync(configPath, backupPath);
    console.log(`✓ Created backup: ${backupPath}`);
  }
}

function initializeConfig() {
  console.log('🏗️ Initializing MCP configuration...');

  const configPath = CONFIG_FILE;
  const config = loadConfig(configPath);

  // Ensure servers object exists
  if (!config.servers) {
    config.servers = {};
  }

  saveConfig(configPath, config);

  console.log('✓ MCP configuration initialized successfully!');
  console.log(`✓ Configuration file: ${configPath}`);
  console.log(`✓ Available server templates: ${Object.keys(SERVER_TEMPLATES).join(', ')}`);

  if (Object.keys(config.servers).length === 0) {
    console.log('\n💡 No servers configured yet. Use the following commands:');
    console.log('   make mcp-web-search  # Install web search server');
    console.log('   make mcp-register    # Register servers in config');
    console.log('   make mcp-enable      # Enable all servers');
  }
}

function registerServer(serverName, serverConfig) {
  console.log(`📝 Registering ${serverName}...`);

  const configPath = CONFIG_FILE;
  createBackup(configPath);

  const config = loadConfig(configPath);

  if (!config.servers) {
    config.servers = {};
  }

  config.servers[serverName] = serverConfig;
  saveConfig(configPath, config);

  console.log(`✓ Registered ${serverName} in configuration`);
  console.log(`   Name: ${serverConfig.name}`);
  console.log(`   Command: ${serverConfig.command} ${(serverConfig.args || []).join(' ')}`);
  if (serverConfig.workingDirectory) {
    console.log(`   Working Directory: ${serverConfig.workingDirectory}`);
  }

  console.log(`   Status: ${serverConfig.enabled ? 'enabled' : 'disabled'}`);
}

function autoDetectFilesystemPath() {
  // Look for filesystem server in the mcp-servers directory
  const possiblePaths = [
    path.join(process.cwd(), 'mcp-servers/filesystem'),
    path.join(process.cwd(), '../mcp-servers/filesystem'),
    '/app/mcp-servers/filesystem',
  ];

  for (const searchPath of possiblePaths) {
    const indexPath = path.join(searchPath, 'index.js');
    const distIndexPath = path.join(searchPath, 'dist/index.js');

    if (fs.existsSync(indexPath) || fs.existsSync(distIndexPath)) {
      console.log(`✓ Found filesystem server at: ${searchPath}`);

      return searchPath;
    }
  }

  console.log('✗ Filesystem server not found in expected locations:');
  possiblePaths.forEach((searchPath) => {
    console.log(`   ${searchPath}`);
  });

  return null;
}

function autoDetectWebSearchPath() {
  // Look for web search server in the mcp-servers directory
  const possiblePaths = [
    path.join(process.cwd(), 'mcp-servers/web-search'),
    path.join(process.cwd(), '../mcp-servers/web-search'),
    '/app/mcp-servers/web-search',
  ];

  for (const searchPath of possiblePaths) {
    const indexPath = path.join(searchPath, 'dist/index.js');

    if (fs.existsSync(indexPath)) {
      console.log(`✓ Found web search server at: ${searchPath}`);

      return searchPath;
    }
  }

  console.log('✗ Web search server not found in expected locations:');
  possiblePaths.forEach((searchPath) => {
    console.log(`   ${searchPath}`);
  });

  return null;
}

function registerFilesystemServer() {
  console.log('📁 Looking for filesystem server...');

  const serverPath = autoDetectFilesystemPath();
  if (!serverPath) {
    console.log('✗ Cannot register filesystem server - not found');
    console.log(`   Run 'make mcp' to install it first`);

    return false;
  }

  const serverConfig = { ...SERVER_TEMPLATES['filesystem'] };
  // No workingDirectory needed for npx approach

  registerServer('filesystem', serverConfig);

  return true;
}

function registerWebSearchServer() {
  console.log('🔍 Looking for web search server...');

  const serverPath = autoDetectWebSearchPath();
  if (!serverPath) {
    console.log('✗ Cannot register web search server - not found');
    console.log(`   Run 'make mcp' to install it first`);

    return false;
  }

  const serverConfig = { ...SERVER_TEMPLATES['web-search'] };
  // Use local build approach - needs working directory and environment
  serverConfig.workingDirectory = '${PROJECT_ROOT}/mcp-servers/web-search';
  serverConfig.env = {
    PLAYWRIGHT_BROWSERS_PATH: '${PROJECT_ROOT}/mcp-servers/web-search/playwright-browsers',
  };

  registerServer('web-search', serverConfig);

  return true;
}

function enableServers(serverNames = null) {
  console.log('⚙️  Enabling MCP servers...');

  const configPath = CONFIG_FILE;
  createBackup(configPath);

  const config = loadConfig(configPath);
  let changes = 0;

  for (const [serverName, serverConfig] of Object.entries(config.servers || {})) {
    if (serverNames === null || serverNames.includes(serverName)) {
      if (!serverConfig.enabled) {
        serverConfig.enabled = true;
        console.log(`✓ Enabled: ${serverName}`);
        changes++;
      } else {
        console.log(`ℹ Already enabled: ${serverName}`);
      }
    }
  }

  if (changes > 0) {
    saveConfig(configPath, config);
    console.log(`\n✓ Enabled ${changes} server(s)`);
  } else {
    console.log('\n✓ No changes needed - all servers already enabled');
  }
}

function disableServers(serverNames = null) {
  console.log('⚙️  Disabling MCP servers...');

  const configPath = CONFIG_FILE;
  createBackup(configPath);

  const config = loadConfig(configPath);
  let changes = 0;

  for (const [serverName, serverConfig] of Object.entries(config.servers || {})) {
    if (serverNames === null || serverNames.includes(serverName)) {
      if (serverConfig.enabled) {
        serverConfig.enabled = false;
        console.log(`✓ Disabled: ${serverName}`);
        changes++;
      } else {
        console.log(`ℹ Already disabled: ${serverName}`);
      }
    }
  }

  if (changes > 0) {
    saveConfig(configPath, config);
    console.log(`\n✓ Disabled ${changes} server(s)`);
  } else {
    console.log('\n✓ No changes needed - all servers already disabled');
  }
}

function showStatus() {
  console.log('📊 MCP Server Configuration Status\n');

  const configPath = CONFIG_FILE;

  if (!fs.existsSync(configPath)) {
    console.log('✗ Configuration file does not exist');
    console.log(`   Expected: ${path.resolve(configPath)}`);
    console.log(`   Run 'make mcp-init' to create it`);

    return;
  }

  const config = loadConfig(configPath);
  const servers = config.servers || {};

  if (Object.keys(servers).length === 0) {
    console.log('ℹ No servers configured');
    console.log(`   Run 'make mcp-register' to register servers`);

    return;
  }

  console.log(`📁 Configuration file: ${path.resolve(configPath)}`);
  console.log(`📊 Total servers: ${Object.keys(servers).length}\n`);

  let enabledServers = 0;
  const totalServers = Object.keys(servers).length;

  for (const [serverName, serverConfig] of Object.entries(servers)) {
    const status = serverConfig.enabled ? '✓' : '✗';
    const color = serverConfig.enabled ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';
    const state = serverConfig.enabled ? 'enabled' : 'disabled';

    console.log(`  ${color}${status}${reset} ${serverName} (${state})`);

    // Show working directory if it exists
    if (serverConfig.workingDirectory) {
      const dirExists = fs.existsSync(serverConfig.workingDirectory);
      const dirStatus = dirExists ? '✓' : '✗';
      const dirColor = dirExists ? '\x1b[32m' : '\x1b[31m';
      console.log(`    ${dirColor}${dirStatus}${reset} ${serverConfig.workingDirectory}`);
    }

    if (serverConfig.enabled) {
      enabledServers++;
    }
  }

  const disabledServers = totalServers - enabledServers;
  console.log(`\n📊 Summary:`);
  console.log(`  Total servers: ${totalServers}`);
  console.log(`  Enabled: ${enabledServers}`);
  console.log(`  Disabled: ${disabledServers}\n`);
}

function updateServerConfig(serverName, updates) {
  console.log(`⚙️  Updating ${serverName} configuration...`);

  const configPath = CONFIG_FILE;
  createBackup(configPath);

  const config = loadConfig(configPath);

  if (!config.servers || !config.servers[serverName]) {
    console.log(`✗ Server ${serverName} not found in configuration`);

    return;
  }

  const serverConfig = config.servers[serverName];
  let changes = 0;

  for (const [key, value] of Object.entries(updates)) {
    if (serverConfig[key] !== value) {
      console.log(`  ${key}: ${serverConfig[key]} → ${value}`);
      serverConfig[key] = value;
      changes++;
    }
  }

  if (changes > 0) {
    saveConfig(configPath, config);
    console.log(`✓ Updated ${changes} configuration(s) for ${serverName}`);
  } else {
    console.log(`ℹ No changes needed for ${serverName}`);
  }
}

function parseUpdates(updateStrings) {
  const updates = {};

  for (const updateString of updateStrings) {
    const [key, value] = updateString.split('=');
    if (!key || value === undefined) {
      console.log(`✗ Invalid update format: ${updateString}`);
      console.log(`   Expected format: key=value`);
      continue;
    }

    // Try to parse boolean and numeric values
    if (value === 'true') {
      updates[key] = true;
    } else if (value === 'false') {
      updates[key] = false;
    } else if (!isNaN(value) && !isNaN(parseFloat(value))) {
      updates[key] = parseFloat(value);
    } else {
      updates[key] = value;
    }
  }

  return updates;
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'init': {
      initializeConfig();
      break;
    }

    case 'register': {
      const serverName = args[1];
      if (serverName === 'web-search') {
        registerWebSearchServer();
      } else if (serverName === 'filesystem') {
        registerFilesystemServer();
      } else if (serverName) {
        console.log(`✗ Unknown server: ${serverName}`);
        console.log(`   Available servers: web-search, filesystem`);
      } else {
        console.log('📝 Registering all available servers...');
        registerFilesystemServer();
        registerWebSearchServer();
      }

      break;
    }

    case 'enable': {
      const serverNames = args.slice(1);
      enableServers(serverNames.length > 0 ? serverNames : null);
      break;
    }

    case 'disable': {
      const serverNames = args.slice(1);
      disableServers(serverNames.length > 0 ? serverNames : null);
      break;
    }

    case 'status': {
      showStatus();
      break;
    }

    case 'update': {
      const serverName = args[1];
      const updateStrings = args.slice(2);

      if (!serverName) {
        console.log('✗ Please specify a server name');
        console.log('   Usage: node mcp-config.js update <server-name> <key=value> ...');
        process.exit(1);
      }

      if (updateStrings.length === 0) {
        console.log('✗ Please specify updates');
        console.log('   Usage: node mcp-config.js update <server-name> <key=value> ...');
        console.log('   Example: node mcp-config.js update web-search enabled=true timeout=30000');
        process.exit(1);
      }

      const updates = parseUpdates(updateStrings);
      updateServerConfig(serverName, updates);
      break;
    }

    default: {
      console.log('🔧 MCP Configuration Manager\n');
      console.log('Usage: node mcp-config.js <command> [options]\n');
      console.log('Commands:');
      console.log('  init                     Initialize configuration file');
      console.log('  register [server-name]   Register server(s) in configuration');
      console.log('  enable [server-names...]  Enable server(s)');
      console.log('  disable [server-names...] Disable server(s)');
      console.log('  status                   Show configuration status');
      console.log('  update <server> <k=v>... Update server configuration');
      console.log('\nExamples:');
      console.log('  node mcp-config.js init');
      console.log('  node mcp-config.js register web-search');
      console.log('  node mcp-config.js enable');
      console.log('  node mcp-config.js disable web-search');
      console.log('  node mcp-config.js update web-search enabled=true timeout=60000');

      if (command) {
        console.log(`\n✗ Unknown command: ${command}`);
        process.exit(1);
      }

      break;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { initializeConfig, registerServer, enableServers, disableServers, showStatus, updateServerConfig };
