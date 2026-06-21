import { Entity, Column, PrimaryColumn, CreateDateColumn } from 'typeorm';

/**
 * A device-pairing handshake initiated by the Companion applet.
 *
 * The applet (unauthenticated) calls `startPairing` and receives the
 * `pairing_token` (shared, embedded in the approval URL) plus a secret
 * `poll_key` used only by the applet to read status. A signed-in user opens the
 * approval URL and approves it, which binds the pairing to their account, mints
 * a long-lived `applet_access_token`, and assigns a `device_id`.
 */
@Entity({ schema: 'ci', name: 'applet_pairing' })
export class AppletPairingEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text', unique: true })
  pairing_token!: string;

  @Column({ type: 'text' })
  poll_key!: string;

  // PENDING until a user approves, then COMPLETED.
  @Column({ type: 'text', default: 'PENDING' })
  status!: string;

  @Column({ type: 'uuid', nullable: true })
  user_id?: string | null;

  @Column({ type: 'text', nullable: true })
  user_name?: string | null;

  @Column({ type: 'text', nullable: true })
  user_email?: string | null;

  @Column({ type: 'uuid', nullable: true })
  device_id?: string | null;

  @Column({ type: 'text', nullable: true })
  applet_access_token?: string | null;

  @Column({ type: 'timestamptz' })
  expires_at!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

export type AppletPairing = Readonly<AppletPairingEntity>;
