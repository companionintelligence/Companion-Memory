import { ChildEntity, Column } from 'typeorm';

import { BaseEntity } from './BaseEntity';

/**
 * A file's presence in the knowledge graph, stored as a `File`-discriminated row
 * in the shared `ci.entities` table.
 *
 * This is NOT the files domain's `FileEntity` (`@ci/domains/files`, table
 * `ci.files`), which owns the content, storage key, and metadata. This row only
 * references that record — `linked_table = 'files'`, `linked_id = <file uuid>`
 * — so the graph can relate a file to people, events, and places without the
 * files domain knowing the graph exists. The dependency runs one way: memory
 * listens for `FileUploadedEvent` and maintains this row; files never imports
 * memory.
 */
@ChildEntity('File')
export class FileEntity extends BaseEntity {
  // Declared byte-identical to PersonEntity's: the columns are nullable in the
  // DB (with a both-or-neither CHECK), and two children must not disagree about
  // one physical column.
  @Column({ type: 'text', name: 'linked_table', nullable: true })
  linkedTable!: string | null;

  @Column({ type: 'text', name: 'linked_id', nullable: true })
  linkedId!: string | null;

  static toEgressType(entity: FileEntity): File {
    return {
      id: entity.id,
      name: entity.name,
      description: entity.description,
      properties: entity.properties,
      linkedTable: entity.linkedTable,
      linkedId: entity.linkedId,
      userId: entity.userId ?? null,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type File = Readonly<FileEntity>;
