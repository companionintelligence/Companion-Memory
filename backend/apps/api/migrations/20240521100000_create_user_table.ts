import { Knex } from 'knex';
import pgvector from 'pgvector/knex';

exports.up = async function (knex: Knex): Promise<void> {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS vector');

  await knex.schema.createTable('person', (table) => {
    table.string('id').primary();
    table.string('first_name').notNullable();
    table.string('last_name').notNullable();
    table.timestamp('created').notNullable();
    table.specificType('embedding', 'vector(3)');
  });
};

exports.down = async function (knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('person');
};
