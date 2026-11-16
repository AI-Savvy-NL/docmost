import { Global, Module } from '@nestjs/common';
import { LicenseTrustService } from './license-trust.service';
import { WikisavvyLicenseRepo } from './license.repo';
import { LicensingService } from './licensing.service';
import { LicensingController } from './licensing.controller';

@Global()
@Module({
  providers: [LicenseTrustService, WikisavvyLicenseRepo, LicensingService],
  controllers: [LicensingController],
  exports: [LicensingService],
})
export class WikisavvyLicensingModule {}
