import { Knex } from 'knex';

exports.up = async function(knex: Knex): Promise<void> {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS vector');
};

exports.down = async function(knex: Knex): Promise<void> {
  await knex.raw('DROP EXTENSION IF EXISTS vector');
};
