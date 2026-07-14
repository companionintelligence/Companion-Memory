import { Entity, Column, PrimaryColumn, CreateDateColumn } from 'typeorm';

/**
 * A short-lived, single-use authorization code for the app-connect flow.
 *
 * Mirrors the `ci.connect_codes` table. The raw connect code is never stored —
 * only its SHA-256 hash. The code is a pure authorization grant: it carries no
 * key material (the key is minted at exchange time), so a database read cannot
 * recover a secret. A row is valid until `expires_at` and is consumed
 * (`used_at` set) by the single exchange call.
 */
@Entity({ schema: 'ci', name: 'connect_codes' })
export class ConnectCodeEntity {
  /** Primary key (UUID). */
  @PrimaryColumn('uuid')
  id!: string;

  /** SHA-256 hex of the raw code handed to the browser. */
  @Column({ type: 'text' })
  hashed_code!: string;

  /** Owning user (the consenting appliance owner). */
  @Column({ type: 'uuid' })
  user_id!: string;

  /** The app (URN) the key was minted for; asserted on exchange. */
  @Column({ type: 'text' })
  app_urn!: string;

  /** Absolute expiry; the code is rejected once this passes. */
  @Column({ type: 'timestamptz' })
  expires_at!: Date;

  /** Set the moment the code is exchanged; a non-null value means "already used". */
  @Column({ type: 'timestamptz', nullable: true })
  used_at!: Date | null;

  /** Row creation timestamp (set by the database). */
  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
