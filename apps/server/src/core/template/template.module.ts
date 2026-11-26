import { Module } from '@nestjs/common';
import { PageModule } from '../page/page.module';
import { StorageModule } from '../../integrations/storage/storage.module';
import { TemplateController } from './template.controller';
import { TemplateService } from './template.service';
import { TemplateFilesService } from './template-files.service';
import { TemplatePublicationPolicy } from './template-publication-policy';

@Module({
  imports: [PageModule, StorageModule],
  controllers: [TemplateController],
  providers: [TemplateService, TemplateFilesService, TemplatePublicationPolicy],
})
export class TemplateModule {}
