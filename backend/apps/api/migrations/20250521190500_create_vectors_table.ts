import { Knex } from 'knex';

exports.up = async function(knex: Knex): Promise<void> {
  await knex.schema.createTable('vectors', (table) => {
    table.increments('id').primary();
    table.specificType('embedding', 'vector(3)'); // Example: 3-dimensional vector
    table.string('label');
  });
};

exports.down = async function(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('vectors');
};
