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
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { RequireSessionAuth } from '../../common/decorators/require-session-auth.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UserRole } from '../../common/helpers/types/permission';
import { User, Workspace } from '../../database/types/entity.types';
import { WikisavvyAuditService } from './audit.service';

export class AuditHistoryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  beforeCursor?: string;
}

@Controller('wikisavvy/audit')
@UseGuards(JwtAuthGuard)
@RequireSessionAuth()
export class WikisavvyAuditController {
  constructor(private readonly audit: WikisavvyAuditService) {}

  @Post('history')
  @HttpCode(HttpStatus.OK)
  async list(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Body() options: AuditHistoryDto,
    @Req() request?: FastifyRequest,
  ) {
    if (
      user?.role !== UserRole.OWNER ||
      user.workspaceId !== workspace?.id ||
      !request?.raw?.['sessionId']
    ) {
      throw new ForbiddenException();
    }
    return this.audit.list(workspace.id, options);
  }
}
