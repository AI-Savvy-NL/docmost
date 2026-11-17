import { Module } from '@nestjs/common';
import { CollabAccessModule } from '../../collaboration/collab-access.module';
import { WsModule } from '../../ws/ws.module';
import { WikisavvyLicensingModule } from '../licensing/licensing.module';
import { WikisavvyPagePermissionController } from './page-permission.controller';
import { WikisavvyPagePermissionEffects } from './page-permission-effects';
import { WikisavvyPagePermissionPolicy } from './page-permission-policy';
import { WikisavvyPagePermissionRepo } from './page-permission.repo';
import { WikisavvyPagePermissionService } from './page-permission.service';

@Module({
  imports: [WikisavvyLicensingModule, CollabAccessModule, WsModule],
  controllers: [WikisavvyPagePermissionController],
  providers: [
    WikisavvyPagePermissionPolicy,
    WikisavvyPagePermissionRepo,
    WikisavvyPagePermissionService,
    WikisavvyPagePermissionEffects,
  ],
})
export class WikisavvyPagePermissionModule {}
