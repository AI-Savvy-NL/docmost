import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { RequireSessionAuth } from '../../common/decorators/require-session-auth.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User, Workspace } from '../../database/types/entity.types';
import { WikisavvyPagePermissionService } from './page-permission.service';
import {
  PermissionPageDto,
  PermissionPrincipalSearchDto,
  PermissionRevisionDto,
  SetPagePermissionDto,
} from './page-permission.dto';

@Controller('wikisavvy/page-permissions')
@UseGuards(JwtAuthGuard)
@RequireSessionAuth()
export class WikisavvyPagePermissionController {
  constructor(private readonly permissions: WikisavvyPagePermissionService) {}

  private actor(user: User, workspace: Workspace, request: FastifyRequest) {
    if (user.workspaceId !== workspace?.id || !request.raw['sessionId'])
      throw new ForbiddenException();
    return { id: user.id, workspaceId: workspace.id };
  }

  @Post('info')
  @HttpCode(HttpStatus.OK)
  info(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Body() dto: PermissionPageDto,
    @Req() request: FastifyRequest,
  ) {
    return this.permissions.state(
      this.actor(user, workspace, request),
      dto.pageId,
    );
  }

  @Post('principals')
  @HttpCode(HttpStatus.OK)
  principals(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Body() dto: PermissionPrincipalSearchDto,
    @Req() request: FastifyRequest,
  ) {
    return this.permissions.principals(
      this.actor(user, workspace, request),
      dto.pageId,
      dto.query,
    );
  }

  @Post('set')
  @HttpCode(HttpStatus.OK)
  set(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Body() dto: SetPagePermissionDto,
    @Req() request: FastifyRequest,
  ) {
    return this.permissions.set(
      this.actor(user, workspace, request),
      dto.pageId,
      dto,
    );
  }

  @Post('remove')
  @HttpCode(HttpStatus.OK)
  remove(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Body() dto: PermissionRevisionDto,
    @Req() request: FastifyRequest,
  ) {
    return this.permissions.remove(
      this.actor(user, workspace, request),
      dto.pageId,
      dto.revision,
    );
  }
}
