import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('oauth_providers')
export class OAuthProviderEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  @Index()
  name!: string;

  @Column({ name: 'display_name' })
  displayName!: string;

  @Column({ name: 'client_id' })
  clientId!: string;

  @Column({ name: 'client_secret' })
  clientSecret!: string;

  @Column({ name: 'authorization_url' })
  authorizationUrl!: string;

  @Column({ name: 'token_url' })
  tokenUrl!: string;

  @Column('json')
  scopes!: string[];

  @Column({ name: 'redirect_uri' })
  redirectUri!: string;

  @Column({ default: true })
  active!: boolean;

  @Column({ name: 'logo_url', nullable: true })
  logoUrl?: string;

  @Column({ nullable: true })
  description?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}