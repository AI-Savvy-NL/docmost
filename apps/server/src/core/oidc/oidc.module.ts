import { Module } from '@nestjs/common';
import { WikisavvyOidcController } from './oidc.controller';
import { WikisavvyOidcService } from './oidc.service';
import { WikisavvyOidcRepo } from './oidc.repo';
import { WikisavvyOidcHttp } from './oidc-http';
import { WikisavvyOidcProtocol } from './oidc-protocol';

@Module({
  controllers: [WikisavvyOidcController],
  providers: [
    WikisavvyOidcService,
    WikisavvyOidcRepo,
    WikisavvyOidcHttp,
    WikisavvyOidcProtocol,
  ],
})
export class WikisavvyOidcModule {}
