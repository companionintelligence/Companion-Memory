#!/usr/bin/env ts-node
/**
 * ETL Configuration Validator
 * 
 * This script validates provider configurations, API specifications, and transform maps
 * for correctness, completeness, and consistency.
 * 
 * Usage:
 *   yarn validate:etl-config
 *   yarn validate:etl-config --provider=google
 *   yarn validate:etl-config --verbose
 */

import * as fs from 'fs';
import * as path from 'path';

// Parse command line arguments
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const specificProvider = args.find(arg => arg.startsWith('--provider='))?.split('=')[1];

const CONFIG_BASE_PATH = path.join(__dirname, '../../../../config');
const PROVIDERS_PATH = path.join(CONFIG_BASE_PATH, 'providers');
const API_SPECS_PATH = path.join(CONFIG_BASE_PATH, 'api-specs');
const TRANSFORM_MAPS_PATH = path.join(CONFIG_BASE_PATH, 'transform-maps');

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

interface ValidationStats {
  total: number;
  valid: number;
  invalid: number;
  warnings: number;
}

function loadJsonFile(filePath: string): any {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to parse JSON: ${error.message}`);
  }
}

function validateProviderConfig(config: any, providerId: string): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  // Required fields
  const requiredFields = ['name', 'displayName', 'category', 'authType', 'sources', 'apiSpecId'];
  for (const field of requiredFields) {
    if (!config[field]) {
      result.errors.push(`Missing required field: ${field}`);
      result.valid = false;
    }
  }

  // Validate authType
  const validAuthTypes = ['oauth1', 'oauth2', 'apiKey'];
  if (config.authType && !validAuthTypes.includes(config.authType)) {
    result.errors.push(`Invalid authType: ${config.authType}. Must be one of: ${validAuthTypes.join(', ')}`);
    result.valid = false;
  }

  // Validate OAuth config for OAuth providers
  if (config.authType === 'oauth2' && !config.oauth) {
    result.errors.push('OAuth2 provider missing oauth configuration');
    result.valid = false;
  } else if (config.oauth) {
    const requiredOAuthFields = ['authUrl', 'tokenUrl', 'scopes'];
    for (const field of requiredOAuthFields) {
      if (!config.oauth[field]) {
        result.errors.push(`Missing required oauth field: ${field}`);
        result.valid = false;
      }
    }
  }

  // Validate sources
  if (config.sources && !Array.isArray(config.sources)) {
    result.errors.push('sources must be an array');
    result.valid = false;
  } else if (config.sources) {
    config.sources.forEach((source: any, idx: number) => {
      if (!source.id) {
        result.errors.push(`Source ${idx} missing id field`);
        result.valid = false;
      }
      if (!source.name) {
        result.errors.push(`Source ${idx} missing name field`);
        result.valid = false;
      }
      if (!source.endpoint) {
        result.errors.push(`Source ${source.id || idx} missing endpoint field`);
        result.valid = false;
      }
      if (!source.transformMapId) {
        result.warnings.push(`Source ${source.id || idx} missing transformMapId - transform will fail`);
      }
    });
  }

  // Validate apiSpecId references existing spec
  if (config.apiSpecId) {
    const specPath = path.join(API_SPECS_PATH, `${config.apiSpecId}.spec.json`);
    if (!fs.existsSync(specPath)) {
      result.errors.push(`Referenced API spec not found: ${config.apiSpecId}`);
      result.valid = false;
    }
  }

  // Check for recommended fields
  if (!config.description) {
    result.warnings.push('Missing recommended field: description');
  }
  if (!config.theme) {
    result.warnings.push('Missing recommended field: theme (for UI branding)');
  }

  return result;
}

function validateApiSpec(spec: any, specId: string): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  // Required fields
  const requiredFields = ['name', 'version', 'baseUrl', 'authType', 'endpoints'];
  for (const field of requiredFields) {
    if (!spec[field]) {
      result.errors.push(`Missing required field: ${field}`);
      result.valid = false;
    }
  }

  // Validate baseUrl is valid URL
  if (spec.baseUrl) {
    try {
      new URL(spec.baseUrl);
    } catch {
      result.errors.push(`Invalid baseUrl: ${spec.baseUrl}`);
      result.valid = false;
    }
  }

  // Validate endpoints
  if (spec.endpoints && typeof spec.endpoints === 'object') {
    Object.entries(spec.endpoints).forEach(([endpointId, endpoint]: [string, any]) => {
      if (!endpoint.method) {
        result.errors.push(`Endpoint ${endpointId} missing method field`);
        result.valid = false;
      }
      if (!endpoint.path) {
        result.errors.push(`Endpoint ${endpointId} missing path field`);
        result.valid = false;
      }

      // Validate method
      const validMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND'];
      if (endpoint.method && !validMethods.includes(endpoint.method)) {
        result.errors.push(`Endpoint ${endpointId} has invalid method: ${endpoint.method}`);
        result.valid = false;
      }

      // Warn if no pagination for GET endpoints
      if (endpoint.method === 'GET' && !endpoint.pagination) {
        result.warnings.push(`Endpoint ${endpointId} (GET) has no pagination config`);
      }
    });
  }

  // Validate rate limiting if present
  if (spec.globalRateLimit) {
    const rl = spec.globalRateLimit;
    if (!rl.requests || !rl.window) {
      result.errors.push('globalRateLimit missing requests or window field');
      result.valid = false;
    }
  }

  return result;
}

function validateTransformMap(map: any, mapId: string): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  // Required fields
  const requiredFields = ['name', 'sourceType', 'targetType', 'version', 'fieldMappings'];
  for (const field of requiredFields) {
    if (!map[field]) {
      result.errors.push(`Missing required field: ${field}`);
      result.valid = false;
    }
  }

  // Validate targetType
  const validTargetTypes = ['communication', 'event', 'content', 'relationship'];
  if (map.targetType && !validTargetTypes.includes(map.targetType)) {
    result.errors.push(`Invalid targetType: ${map.targetType}. Must be one of: ${validTargetTypes.join(', ')}`);
    result.valid = false;
  }

  // Validate fieldMappings
  if (map.fieldMappings && Array.isArray(map.fieldMappings)) {
    map.fieldMappings.forEach((mapping: any, idx: number) => {
      if (!mapping.target) {
        result.errors.push(`Field mapping ${idx} missing target field`);
        result.valid = false;
      }
      if (!mapping.type) {
        result.errors.push(`Field mapping ${idx} missing type field`);
        result.valid = false;
      }

      const validTypes = ['direct', 'nested', 'computed', 'template', 'constant'];
      if (!validTypes.includes(mapping.type)) {
        result.errors.push(`Field mapping ${idx} has invalid type: ${mapping.type}`);
        result.valid = false;
      }

      // Type-specific validation
      if (mapping.type === 'direct' && !mapping.source) {
        result.errors.push(`Direct mapping ${mapping.target} missing source field`);
        result.valid = false;
      }
      if (mapping.type === 'nested' && !mapping.path) {
        result.errors.push(`Nested mapping ${mapping.target} missing path field`);
        result.valid = false;
      }
      if (mapping.type === 'computed' && !mapping.transformer) {
        result.errors.push(`Computed mapping ${mapping.target} missing transformer field`);
        result.valid = false;
      }
      if (mapping.type === 'template' && !mapping.template) {
        result.errors.push(`Template mapping ${mapping.target} missing template field`);
        result.valid = false;
      }
      if (mapping.type === 'constant' && mapping.value === undefined) {
        result.errors.push(`Constant mapping ${mapping.target} missing value field`);
        result.valid = false;
      }
    });

    // Warn if essential fields are missing
    const essentialFields = ['id', 'title', 'timestamp'];
    const mappedFields = map.fieldMappings.map((m: any) => m.target);
    essentialFields.forEach(field => {
      if (!mappedFields.includes(field)) {
        result.warnings.push(`Missing essential field mapping: ${field}`);
      }
    });
  }

  return result;
}

async function main() {
  console.log('🔍 ETL Configuration Validator');
  console.log('============================\n');

  if (specificProvider) {
    console.log(`📌 Validating only provider: ${specificProvider}\n`);
  }

  const stats: Record<string, ValidationStats> = {
    providers: { total: 0, valid: 0, invalid: 0, warnings: 0 },
    apiSpecs: { total: 0, valid: 0, invalid: 0, warnings: 0 },
    transformMaps: { total: 0, valid: 0, invalid: 0, warnings: 0 },
  };

  let hasErrors = false;

  // Validate providers
  console.log('📦 Validating Provider Configurations...\n');
  const providerFiles = fs.readdirSync(PROVIDERS_PATH).filter(f => f.endsWith('.provider.json'));
  
  for (const file of providerFiles) {
    const providerId = file.replace('.provider.json', '');
    
    if (specificProvider && providerId !== specificProvider) {
      continue;
    }

    stats.providers.total++;
    try {
      const config = loadJsonFile(path.join(PROVIDERS_PATH, file));
      const result = validateProviderConfig(config, providerId);
      
      if (result.valid) {
        stats.providers.valid++;
        console.log(`  ✅ ${config.name} (${providerId})`);
      } else {
        stats.providers.invalid++;
        hasErrors = true;
        console.log(`  ❌ ${config.name} (${providerId})`);
        result.errors.forEach(err => console.log(`     - ${err}`));
      }

      if (result.warnings.length > 0) {
        stats.providers.warnings += result.warnings.length;
        if (verbose) {
          result.warnings.forEach(warn => console.log(`     ⚠️  ${warn}`));
        }
      }
    } catch (error) {
      stats.providers.invalid++;
      hasErrors = true;
      console.log(`  ❌ ${providerId}: ${error.message}`);
    }
  }

  // Validate API specs
  console.log('\n🔌 Validating API Specifications...\n');
  const apiSpecFiles = fs.readdirSync(API_SPECS_PATH).filter(f => f.endsWith('.spec.json'));
  
  for (const file of apiSpecFiles) {
    const specId = file.replace('.spec.json', '');
    stats.apiSpecs.total++;

    try {
      const spec = loadJsonFile(path.join(API_SPECS_PATH, file));
      const result = validateApiSpec(spec, specId);
      
      if (result.valid) {
        stats.apiSpecs.valid++;
        console.log(`  ✅ ${spec.name} (${specId})`);
      } else {
        stats.apiSpecs.invalid++;
        hasErrors = true;
        console.log(`  ❌ ${spec.name} (${specId})`);
        result.errors.forEach(err => console.log(`     - ${err}`));
      }

      if (result.warnings.length > 0) {
        stats.apiSpecs.warnings += result.warnings.length;
        if (verbose) {
          result.warnings.forEach(warn => console.log(`     ⚠️  ${warn}`));
        }
      }
    } catch (error) {
      stats.apiSpecs.invalid++;
      hasErrors = true;
      console.log(`  ❌ ${specId}: ${error.message}`);
    }
  }

  // Validate transform maps
  console.log('\n🔄 Validating Transform Maps...\n');
  const transformMapFiles = fs.readdirSync(TRANSFORM_MAPS_PATH).filter(f => f.endsWith('.transform.json'));
  
  for (const file of transformMapFiles) {
    const mapId = file.replace('.transform.json', '');
    stats.transformMaps.total++;

    try {
      const map = loadJsonFile(path.join(TRANSFORM_MAPS_PATH, file));
      const result = validateTransformMap(map, mapId);
      
      if (result.valid) {
        stats.transformMaps.valid++;
        console.log(`  ✅ ${map.name} (${mapId})`);
      } else {
        stats.transformMaps.invalid++;
        hasErrors = true;
        console.log(`  ❌ ${map.name} (${mapId})`);
        result.errors.forEach(err => console.log(`     - ${err}`));
      }

      if (result.warnings.length > 0) {
        stats.transformMaps.warnings += result.warnings.length;
        if (verbose) {
          result.warnings.forEach(warn => console.log(`     ⚠️  ${warn}`));
        }
      }
    } catch (error) {
      stats.transformMaps.invalid++;
      hasErrors = true;
      console.log(`  ❌ ${mapId}: ${error.message}`);
    }
  }

  // Print summary
  console.log('\n📊 Validation Summary');
  console.log('===================\n');
  console.log(`Providers: ${stats.providers.valid}/${stats.providers.total} valid`);
  console.log(`  - Valid: ${stats.providers.valid}`);
  console.log(`  - Invalid: ${stats.providers.invalid}`);
  console.log(`  - Warnings: ${stats.providers.warnings}`);
  console.log(`\nAPI Specs: ${stats.apiSpecs.valid}/${stats.apiSpecs.total} valid`);
  console.log(`  - Valid: ${stats.apiSpecs.valid}`);
  console.log(`  - Invalid: ${stats.apiSpecs.invalid}`);
  console.log(`  - Warnings: ${stats.apiSpecs.warnings}`);
  console.log(`\nTransform Maps: ${stats.transformMaps.valid}/${stats.transformMaps.total} valid`);
  console.log(`  - Valid: ${stats.transformMaps.valid}`);
  console.log(`  - Invalid: ${stats.transformMaps.invalid}`);
  console.log(`  - Warnings: ${stats.transformMaps.warnings}`);

  const totalWarnings = stats.providers.warnings + stats.apiSpecs.warnings + stats.transformMaps.warnings;
  if (totalWarnings > 0 && !verbose) {
    console.log(`\n💡 Run with --verbose to see ${totalWarnings} warnings`);
  }

  if (hasErrors) {
    console.log('\n❌ Validation failed!');
    process.exit(1);
  } else {
    console.log('\n✅ All configurations valid!');
    process.exit(0);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

export { main as validateConfigurations };
