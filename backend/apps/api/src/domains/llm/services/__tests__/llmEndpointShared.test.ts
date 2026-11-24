import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  llmApiBaseFromSettings,
  normalizeBasePath,
  readSharedConfig,
  syncAppEnvLlmVars,
  writeSharedConfig,
} from '../llmEndpointShared';

describe('llmEndpointShared', () => {
  it('writes and reads shared endpoint config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-endpoint-'));
    const path = join(dir, 'llm-endpoint.json');

    writeSharedConfig(path, {
      backend: 'openai_compatible',
      port: 8000,
      apiKey: 'vllm-local',
      hostGateway: 'host.docker.internal',
    });

    expect(readSharedConfig(path)).toEqual({
      backend: 'openai_compatible',
      port: 8000,
      apiKey: 'vllm-local',
      hostGateway: 'host.docker.internal',
    });
  });

  it('builds OpenAI-compatible base URLs', () => {
    expect(
      llmApiBaseFromSettings({
        backend: 'openai_compatible',
        hostGateway: 'host.docker.internal',
        port: 8000,
        apiKey: 'vllm-local',
      }),
    ).toBe('http://host.docker.internal:8000/v1');
    expect(
      llmApiBaseFromSettings({
        backend: 'openai_compatible',
        hostGateway: 'host.docker.internal',
        port: 13305,
        basePath: '/api/v1',
        apiKey: 'x',
      }),
    ).toBe('http://host.docker.internal:13305/api/v1');
    // Ollama's compatibility layer is always at /v1, whatever a stale setting says.
    expect(
      llmApiBaseFromSettings({
        backend: 'ollama',
        hostGateway: 'h',
        port: 11434,
        basePath: '/api/v1',
        apiKey: 'x',
      }),
    ).toBe('http://h:11434/v1');
  });

  it('normalizes an API root: default, slashes, and a bare name', () => {
    expect(normalizeBasePath(undefined)).toBe('/v1');
    expect(normalizeBasePath('')).toBe('/v1');
    expect(normalizeBasePath('/')).toBe('/v1');
    expect(normalizeBasePath('api/v1/')).toBe('/api/v1');
    expect(normalizeBasePath(' /openai/v1 ')).toBe('/openai/v1');
  });

  it('patches app.env with LLM vars', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-env-'));
    const appEnvPath = join(dir, 'app.env');

    writeFileSync(appEnvPath, 'APP_PORT=8642\nLLM_API_BASE=http://host.docker.internal:11434/v1\n');

    process.env.APP_DATA_DIR = dir;

    syncAppEnvLlmVars({
      backend: 'openai_compatible',
      hostGateway: 'host.docker.internal',
      port: 8000,
      apiKey: 'vllm-local',
    });

    expect(readFileSync(appEnvPath, 'utf8')).toContain('LLM_API_BASE=http://host.docker.internal:8000/v1');
    expect(readFileSync(appEnvPath, 'utf8')).toContain('LLM_API_KEY=vllm-local');

    delete process.env.APP_DATA_DIR;
  });
});
