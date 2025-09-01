#!/usr/bin/env ts-node

import 'tsconfig-paths/register';
import 'dotenv/config';

import { Command } from 'commander';
import { select, input, confirm } from '@inquirer/prompts';

import { LoggerService } from '@ci/common/services';
import config from '@ci/configuration';
import { DataSource } from 'typeorm';

import { OAuthProviderEntity } from '../src/domains/auth-broker/entities/OAuthProviderEntity';

const logger = new LoggerService('auth-broker-setup');

const program = new Command();

async function createDataSource() {
  const dataSource = new DataSource({
    type: config.db.type,
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    username: config.db.username,
    password: config.db.password,
    entities: [OAuthProviderEntity],
    synchronize: false,
  });

  await dataSource.initialize();

  return dataSource;
}

program
  .name('auth-broker-setup')
  .description('Setup and manage OAuth providers for the Auth Broker')
  .version('1.0.0');

program
  .command('configure-provider')
  .description('Configure OAuth credentials for a provider')
  .action(async () => {
    try {
      const dataSource = await createDataSource();
      const providerRepository = dataSource.getRepository(OAuthProviderEntity);

      // Get all providers
      const providers = await providerRepository.find();

      if (providers.length === 0) {
        logger.error('No OAuth providers found. Please run migrations first.');
        process.exit(1);
      }

      const providerId = await select({
        message: 'Select OAuth provider to configure:',
        choices: providers.map((p) => ({
          name: `${p.displayName} (${p.name})`,
          value: p.id,
          description: p.description,
        })),
      });

      const provider = providers.find((p) => p.id === providerId)!;

      logger.log('Current configuration:', {
        name: provider.name,
        displayName: provider.displayName,
        clientId: provider.clientId.startsWith('your-') ? '[NOT CONFIGURED]' : '[CONFIGURED]',
        clientSecret: provider.clientSecret.startsWith('your-') ? '[NOT CONFIGURED]' : '[CONFIGURED]',
        redirectUri: provider.redirectUri,
        active: provider.active,
      });

      const shouldConfigure = await confirm({
        message: "Do you want to update this provider's credentials?",
        default: true,
      });

      if (!shouldConfigure) {
        process.exit(0);
      }

      const clientId = await input({
        message: `Enter Client ID for ${provider.displayName}:`,
        default: provider.clientId.startsWith('your-') ? '' : provider.clientId,
        validate: (input) => input.trim().length > 0 || 'Client ID is required',
      });

      const clientSecret = await input({
        message: `Enter Client Secret for ${provider.displayName}:`,
        default: provider.clientSecret.startsWith('your-') ? '' : provider.clientSecret,
        validate: (input) => input.trim().length > 0 || 'Client Secret is required',
      });

      const shouldActivate = await confirm({
        message: 'Activate this provider?',
        default: true,
      });

      // Update provider
      await providerRepository.update(provider.id, {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        active: shouldActivate,
      });

      logger.log('Provider updated successfully', {
        providerId: provider.id,
        name: provider.name,
        active: shouldActivate,
      });

      await dataSource.destroy();
    } catch (error) {
      logger.error('Failed to configure provider', error);
      process.exit(1);
    }
  });

program
  .command('list-providers')
  .description('List all OAuth providers and their status')
  .action(async () => {
    try {
      const dataSource = await createDataSource();
      const providerRepository = dataSource.getRepository(OAuthProviderEntity);

      const providers = await providerRepository.find({
        order: { name: 'ASC' },
      });

      console.log('\nOAuth Providers:');
      console.log('================');

      providers.forEach((provider) => {
        const configured =
          !provider.clientId.startsWith('your-') && !provider.clientSecret.startsWith('your-');
        console.log(`${provider.displayName} (${provider.name})`);
        console.log(`  Status: ${provider.active ? 'Active' : 'Inactive'}`);
        console.log(`  Configured: ${configured ? 'Yes' : 'No'}`);
        console.log(`  Scopes: ${provider.scopes.join(', ')}`);
        console.log(`  Callback: ${provider.redirectUri}`);
        console.log('');
      });

      await dataSource.destroy();
    } catch (error) {
      logger.error('Failed to list providers', error);
      process.exit(1);
    }
  });

program
  .command('test-config')
  .description('Test the auth broker configuration')
  .action(async () => {
    try {
      logger.log('Auth Broker Configuration Test');
      logger.log('==============================');

      logger.log('Base URL:', config.auth.broker.baseUrl);
      logger.log('Callback URL:', config.auth.broker.callbackUrl);

      const dataSource = await createDataSource();
      const providerRepository = dataSource.getRepository(OAuthProviderEntity);

      const activeProviders = await providerRepository.count({ where: { active: true } });
      const configuredProviders = await providerRepository
        .createQueryBuilder('provider')
        .where('provider.active = :active', { active: true })
        .andWhere('provider.clientId NOT LIKE :pattern', { pattern: 'your-%' })
        .getCount();

      logger.log('Active providers:', activeProviders);
      logger.log('Configured providers:', configuredProviders);

      if (configuredProviders === 0) {
        logger.warn('No OAuth providers are configured with valid credentials!');
        logger.info('Run: yarn exec bin/auth-broker-setup.ts configure-provider');
      } else {
        logger.log('Auth broker is ready to use!');
      }

      await dataSource.destroy();
    } catch (error) {
      logger.error('Configuration test failed', error);
      process.exit(1);
    }
  });

if (require.main === module) {
  program.parse();
}
