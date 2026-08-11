import { DataSource } from 'typeorm';

import { NodeEntity } from '@ci/domains/graph';
import { UserEntity } from '@ci/domains/user';

import { BaseEntity } from '../BaseEntity';
import { CommunicationBaseEntity } from '../CommunicationBaseEntity';
import { ConceptEntity } from '../ConceptEntity';
import { EventBaseEntity } from '../EventBaseEntity';
import { EventEntity } from '../EventEntity';
import { FileEntity } from '../FileEntity';
import { GraphNodeEntity } from '../GraphNodeEntity';
import { ItemBaseEntity } from '../ItemBaseEntity';
import { ItemEntity } from '../ItemEntity';
import { PersonEntity } from '../PersonEntity';
import { PlaceEntity } from '../PlaceEntity';

/**
 * ci.entities is mapped by an STI tree (BaseEntity + children) AND by
 * standalone classes (PlaceEntity with a hand-rolled discriminator column,
 * GraphNodeEntity / graph NodeEntity unfiltered). TypeORM builds metadata for
 * all of them against one physical table; this guards that the coexistence
 * keeps constructing as children are added — without a database connection.
 */
describe('memory entity metadata', () => {
  it('builds the STI tree beside the standalone ci.entities mappings', async () => {
    const dataSource = new DataSource({
      type: 'postgres',
      entities: [
        BaseEntity,
        PersonEntity,
        ConceptEntity,
        FileEntity,
        ItemBaseEntity,
        ItemEntity,
        EventBaseEntity,
        EventEntity,
        CommunicationBaseEntity,
        PlaceEntity,
        GraphNodeEntity,
        NodeEntity,
        UserEntity,
      ],
    });

    // Builds and registers metadata without connecting. `buildMetadatas` is
    // protected (initialize() is its only production caller), but it is exactly
    // the connection-free half this test needs.
    await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();

    const discriminatorOf = (target: unknown) => dataSource.getMetadata(target as never).discriminatorValue;

    expect(discriminatorOf(PersonEntity)).toBe('Person');
    expect(discriminatorOf(ConceptEntity)).toBe('Concept');
    expect(discriminatorOf(FileEntity)).toBe('File');
    expect(discriminatorOf(ItemBaseEntity)).toBe('Item');
    expect(discriminatorOf(EventBaseEntity)).toBe('Event');
    expect(discriminatorOf(CommunicationBaseEntity)).toBe('Communication');

    // The detail half of the Item aggregate is NOT part of the STI tree —
    // TypeORM defaults a non-STI entity's discriminatorValue to its class name,
    // so nothing metadata-derived (e.g. future mutation tracking) may treat it
    // as the logical 'Item' type; that has to be stated explicitly.
    expect(discriminatorOf(ItemEntity)).toBe('ItemEntity');
    expect(dataSource.getMetadata(ItemEntity).tableName).toBe('inventory');

    // Children inherit the base columns; the discriminator is metadata-managed,
    // never a declared property.
    const person = dataSource.getMetadata(PersonEntity);
    const columnNames = person.columns.map((column) => column.databaseName);
    expect(columnNames).toEqual(expect.arrayContaining(['entity_id', 'owner_user_id', 'entity_type']));
    expect(person.columns.find((column) => column.databaseName === 'entity_type')?.isDiscriminator).toBe(
      true,
    );
  });
});
