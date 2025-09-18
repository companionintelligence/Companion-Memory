#!/usr/bin/env node

/**
 * Environment validation script for CI-Server
 * Validates that required directories and environment variables are properly configured
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

function validateEnvironment() {
  console.log('🔍 Validating CI-Server environment...\n');

  const errors = [];
  const warnings = [];

  // Check MCP servers directory
  const mcpServersDir = process.env.MCP_SERVERS_DIR || 'mcp-servers';
  const resolvedMcpServersDir = path.resolve(mcpServersDir);

  console.log(`📂 MCP Servers Directory: ${resolvedMcpServersDir}`);

  // Check if MCP servers directory exists or can be created
  try {
    if (!fs.existsSync(resolvedMcpServersDir)) {
      const parentDir = path.dirname(resolvedMcpServersDir);
      if (!fs.existsSync(parentDir)) {
        errors.push(`MCP servers directory parent does not exist: ${parentDir}`);
      } else {
        warnings.push(`MCP servers directory will be created: ${resolvedMcpServersDir}`);
      }
    }
  } catch (error) {
    errors.push(`Cannot access MCP servers directory: ${error.message}`);
  }

  // Check for Node.js and npm
  try {
    execSync('node --version', { stdio: 'ignore' });
    console.log('✅ Node.js is available');
  } catch {
    errors.push('Node.js is not installed or not in PATH');
  }

  try {
    execSync('npm --version', { stdio: 'ignore' });
    console.log('✅ npm is available');
  } catch {
    errors.push('npm is not installed or not in PATH');
  }

  // Check write permissions
  try {
    const configDir = 'backend/apps/api/config';
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    const testFile = path.join(configDir, '.write-test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    console.log('✅ Config directory is writable');
  } catch (error) {
    errors.push(`Cannot write to config directory: ${error.message}`);
  }

  // Print results
  console.log('');

  if (warnings.length > 0) {
    console.log('⚠️  Warnings:');
    warnings.forEach((warning) => console.log(`   ${warning}`));
    console.log('');
  }

  if (errors.length > 0) {
    console.log('❌ Errors:');
    errors.forEach((error) => console.log(`   ${error}`));
    console.log('');
    console.log('Please fix these errors before proceeding.');
    process.exit(1);
  }

  console.log('✅ Environment validation passed!');
  console.log('You can now run: make mcp');
  console.log('');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  validateEnvironment();
}

export { validateEnvironment };
