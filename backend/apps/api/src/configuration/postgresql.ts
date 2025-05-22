// For more information about this file see https://dove.feathersjs.com/guides/cli/databases.html
import knex from 'knex';
import type { Knex } from 'knex';
import type { Application } from './types';

declare module './types' {
  interface Configuration {
    postgresqlClient: Knex;
  }
}

export function postgresql(app: Application) {
  const config = app.get('postgresql');
  const db = knex(config!);

  app.set('postgresqlClient', db);
}
