import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import config from '@ci/configuration';
import { UserEntity } from '@ci/domains/user';

import { AppletPairingEntity } from './entities/AppletPairingEntity';
import { UserSnapshotEntity } from './entities/UserSnapshotEntity';
import { AppletPairingService } from './services/AppletPairingService';

@Module({
  imports: [
    TypeOrmModule.forFeature([AppletPairingEntity, UserSnapshotEntity, UserEntity]),
    // Signs the long-lived applet device token with the access-token secret so
    // the standard JwtStrategy validates it as a normal Bearer token.
    JwtModule.register({ secret: config.auth.jwt.authTokenSecret }),
  ],
  providers: [AppletPairingService],
  exports: [AppletPairingService],
})
export class AppletPairingModule {}

export { AppletPairingService } from './services/AppletPairingService';
export type { SnapshotInput } from './services/AppletPairingService';
