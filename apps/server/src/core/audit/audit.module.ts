import { Global, Module } from '@nestjs/common';
import { AUDIT_SERVICE } from '../../integrations/audit/audit.service';
import { WikisavvyAuditController } from './audit.controller';
import { WikisavvyAuditRepo } from './audit.repo';
import { WikisavvyAuditService } from './audit.service';

@Global()
@Module({
  controllers: [WikisavvyAuditController],
  providers: [
    WikisavvyAuditRepo,
    WikisavvyAuditService,
    { provide: AUDIT_SERVICE, useExisting: WikisavvyAuditService },
  ],
  exports: [AUDIT_SERVICE, WikisavvyAuditService],
})
export class WikisavvyAuditModule {}
