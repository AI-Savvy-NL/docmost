import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { RequireSessionAuth } from '../../common/decorators/require-session-auth.decorator';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User, Workspace } from '../../database/types/entity.types';
import {
  AUTH_THROTTLER,
  ALL_NAMED_THROTTLERS_SKIPPED,
} from '../../integrations/throttle/throttler-names';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { DomainService } from '../../integrations/environment/domain.service';
import { OIDC_FLOW_SECONDS, WikisavvyOidcService } from './oidc.service';
import { OidcConfigureDto, OidcLinkDto, OidcStartDto } from './oidc.dto';

export const OIDC_BROWSER_COOKIE = '__Host-wikisavvy-oidc';
const cookieOptions = {
  path: '/',
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
};

@Controller('oidc')
@SkipThrottle({ ...ALL_NAMED_THROTTLERS_SKIPPED, [AUTH_THROTTLER]: false })
@UseGuards(ThrottlerGuard)
export class WikisavvyOidcController {
  constructor(
    private readonly oidc: WikisavvyOidcService,
    private readonly environment: EnvironmentService,
    private readonly domain: DomainService,
  ) {}

  private session(request: FastifyRequest) {
    const id = request.raw['sessionId'];
    if (typeof id !== 'string' || !id)
      throw new ForbiddenException('An active interactive session is required');
    return id;
  }

  @Post('providers')
  @HttpCode(HttpStatus.OK)
  providers(@AuthWorkspace() workspace: Workspace) {
    return this.oidc.publicProviders(workspace.id);
  }

  @Post('status')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @RequireSessionAuth()
  status(
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
    @Req() request: FastifyRequest,
  ) {
    this.session(request);
    return this.oidc.status(workspace.id, user.id);
  }

  @Post('configure')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @RequireSessionAuth()
  async configure(
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
    @Req() request: FastifyRequest,
    @Body() dto: OidcConfigureDto,
  ) {
    const sessionId = this.session(request);
    await this.oidc.assertOrigin(workspace.id, request.headers.origin);
    return this.oidc.configure(workspace.id, user.id, sessionId, dto);
  }

  @Post('start')
  @HttpCode(HttpStatus.OK)
  async start(
    @AuthWorkspace() workspace: Workspace,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() dto: OidcStartDto,
  ) {
    await this.oidc.assertOrigin(workspace.id, request.headers.origin);
    const flow = await this.oidc.start(workspace.id, dto.providerId);
    reply.header('Cache-Control', 'no-store');
    reply.setCookie(OIDC_BROWSER_COOKIE, flow.browserBinding, {
      ...cookieOptions,
      maxAge: OIDC_FLOW_SECONDS,
    });
    return { authorizationUrl: flow.authorizationUrl };
  }

  @Post('link')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @RequireSessionAuth()
  async link(
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() dto: OidcLinkDto,
  ) {
    const sessionId = this.session(request);
    await this.oidc.assertOrigin(workspace.id, request.headers.origin);
    const flow = await this.oidc.start(workspace.id, dto.providerId, {
      userId: user.id,
      sessionId,
      password: dto.password,
    });
    reply.header('Cache-Control', 'no-store');
    reply.setCookie(OIDC_BROWSER_COOKIE, flow.browserBinding, {
      ...cookieOptions,
      maxAge: OIDC_FLOW_SECONDS,
    });
    return { authorizationUrl: flow.authorizationUrl };
  }

  @Get('callback')
  @SkipTransform()
  async callback(
    @AuthWorkspace() workspace: Workspace,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    reply
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer');
    reply.clearCookie(OIDC_BROWSER_COOKIE, cookieOptions);
    try {
      const base = new URL(this.domain.getWorkspaceUrl(workspace));
      const supplied = new URL(request.raw.url!, base);
      const callback = new URL('/api/oidc/callback', base);
      callback.search = supplied.search;
      const result = await this.oidc.complete(
        workspace.id,
        callback,
        request.cookies[OIDC_BROWSER_COOKIE],
      );
      if (result.flow === 'login' && result.authToken) {
        reply.setCookie('authToken', result.authToken, {
          ...cookieOptions,
          expires: this.environment.getCookieExpiresIn(),
        });
        return reply.redirect('/home', HttpStatus.FOUND);
      }
      return reply.redirect(
        '/settings/account/profile?oidc=linked',
        HttpStatus.FOUND,
      );
    } catch {
      return reply.redirect('/login?oidc=error', HttpStatus.FOUND);
    }
  }
}
