import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ConfigSchema } from '@ci/configuration';

import { PUBLIC_FEATURES } from '../services/FeatureService';

const TRUST_STANDARD_FLAGS = [
  'solid.protocol',
  'mcp.prm',
  'pws.storage',
  'auth.identikey',
  'vtc.credentials',
  'didcomm.messaging',
] as const;

const EXPECTED_ENV_VARS: Record<(typeof TRUST_STANDARD_FLAGS)[number], string> = {
  'solid.protocol': 'ENABLE_SOLID_PROTOCOL',
  'mcp.prm': 'ENABLE_MCP_PRM',
  'pws.storage': 'ENABLE_PWS_STORAGE',
  'auth.identikey': 'ENABLE_AUTH_IDENTIKEY',
  'vtc.credentials': 'ENABLE_VTC_CREDENTIALS',
  'didcomm.messaging': 'ENABLE_DIDCOMM_MESSAGING',
};

describe('Trust & provisional discovery feature flags config (fail-closed defaults)', () => {
  const apiRoot = resolve(__dirname, '../../../..');
  const defaultJson = JSON.parse(readFileSync(resolve(apiRoot, 'config/default.json'), 'utf8')) as {
    features: Record<string, unknown>;
  };
  const envMapJson = JSON.parse(
    readFileSync(resolve(apiRoot, 'config/custom-environment-variables.json'), 'utf8'),
  ) as {
    features: Record<string, string>;
  };

  it('defaults every trust/provisional standard flag to false in config/default.json', () => {
    expect(existsSync(resolve(apiRoot, 'config/default.json'))).toBe(true);

    for (const flag of TRUST_STANDARD_FLAGS) {
      expect(defaultJson.features[flag]).toBe(false);
    }
  });

  it('maps each trust/provisional flag to its expected env var in custom-environment-variables.json', () => {
    for (const flag of TRUST_STANDARD_FLAGS) {
      expect(envMapJson.features[flag]).toBe(EXPECTED_ENV_VARS[flag]);
    }
  });

  it('never exposes provisional trust flags in PUBLIC_FEATURES unauthenticated map', () => {
    for (const flag of TRUST_STANDARD_FLAGS) {
      expect((PUBLIC_FEATURES as readonly string[]).includes(flag)).toBe(false);
    }
  });

  it('parses string booleans and real booleans cleanly through ConfigSchema without enabling flags by accident', () => {
    const parsedDefault = ConfigSchema.parse(defaultJson);
    for (const flag of TRUST_STANDARD_FLAGS) {
      expect(parsedDefault.features[flag]).toBe(false);
    }

    const withStringFalse = {
      ...defaultJson,
      features: {
        ...defaultJson.features,
        'solid.protocol': 'false',
        'mcp.prm': 'false',
        'pws.storage': 'false',
        'auth.identikey': 'false',
        'vtc.credentials': 'false',
        'didcomm.messaging': 'false',
      },
    };
    const parsedFalseStrings = ConfigSchema.parse(withStringFalse);
    for (const flag of TRUST_STANDARD_FLAGS) {
      expect(parsedFalseStrings.features[flag]).toBe(false);
    }

    const withStringTrue = {
      ...defaultJson,
      features: {
        ...defaultJson.features,
        'solid.protocol': 'true',
        'mcp.prm': 'true',
        'pws.storage': 'true',
        'auth.identikey': 'true',
        'vtc.credentials': 'true',
        'didcomm.messaging': 'true',
      },
    };
    const parsedTrueStrings = ConfigSchema.parse(withStringTrue);
    for (const flag of TRUST_STANDARD_FLAGS) {
      expect(parsedTrueStrings.features[flag]).toBe(true);
    }
  });
});
