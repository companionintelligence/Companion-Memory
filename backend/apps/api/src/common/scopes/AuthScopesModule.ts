import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthDenialEntity } from './AuthDenialEntity';
import { AuthDenialLogger } from './AuthDenialLogger';
import { ScopesGuard } from './ScopesGuard';

/**
 * Provides the ScopesGuard + AuthDenialLogger so other modules can opt into
 * scope-aware routing without each one wiring its own TypeORM repository.
 *
 * The guard reads metadata set by `@Scopes(...)`; the logger is consulted on
 * deny so the SPA's "agent activity" view can show which API keys were
 * rejected and why.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AuthDenialEntity])],
  providers: [AuthDenialLogger, ScopesGuard],
  exports: [AuthDenialLogger, ScopesGuard],
})
export class AuthScopesModule {}
