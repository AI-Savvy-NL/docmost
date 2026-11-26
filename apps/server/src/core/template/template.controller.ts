import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { RequireSessionAuth } from '../../common/decorators/require-session-auth.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { StorageService } from '../../integrations/storage/storage.service';
import { TemplateService } from './template.service';
import {
  CreateTemplateDto,
  PrepareTemplateDto,
  TemplateIdDto,
  UpdateTemplateDto,
  UseTemplateDto,
} from './template.dto';

@Controller('templates')
@UseGuards(JwtAuthGuard)
@RequireSessionAuth()
export class TemplateController {
  constructor(
    private readonly templates: TemplateService,
    private readonly storage: StorageService,
  ) {}

  private actor(user: User, workspace: Workspace, req: FastifyRequest) {
    if (user.workspaceId !== workspace.id || !req.raw['sessionId'])
      throw new ForbiddenException();
    return { id: user.id, workspaceId: workspace.id };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  list(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Body() pagination: PaginationOptions,
  ) {
    return this.templates.list(this.actor(user, workspace, req), pagination);
  }

  @Post('info')
  @HttpCode(HttpStatus.OK)
  info(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Body() dto: TemplateIdDto,
  ) {
    return this.templates.info(
      this.actor(user, workspace, req),
      dto.templateId,
    );
  }

  @Post('create')
  @HttpCode(HttpStatus.OK)
  create(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Body() dto: CreateTemplateDto,
  ) {
    return this.templates.create(this.actor(user, workspace, req), dto);
  }

  @Post('update')
  @HttpCode(HttpStatus.OK)
  update(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.templates.update(this.actor(user, workspace, req), dto);
  }

  @Post('delete')
  @HttpCode(HttpStatus.OK)
  remove(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Body() dto: TemplateIdDto,
  ) {
    return this.templates.remove(
      this.actor(user, workspace, req),
      dto.templateId,
    );
  }

  @Post('use')
  @HttpCode(HttpStatus.OK)
  use(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Body() dto: UseTemplateDto,
  ) {
    return this.templates.use(this.actor(user, workspace, req), dto);
  }

  @Get('files/:fileId/:fileName')
  async file(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @Param('fileId', new ParseUUIDPipe()) fileId: string,
  ) {
    const attachment = await this.templates.file(
      this.actor(user, workspace, req),
      fileId,
    );
    const inline =
      /^(image\/(png|jpeg|gif|webp)|audio\/(mpeg|ogg|wav)|video\/(mp4|webm)|application\/pdf)$/.test(
        attachment.mimeType ?? '',
      );
    res.headers({
      'Content-Type': inline ? attachment.mimeType : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
    });
    return res.send(await this.storage.readStream(attachment.filePath));
  }

  @Post('prepare')
  @HttpCode(HttpStatus.OK)
  prepare(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Body() dto: PrepareTemplateDto,
  ) {
    return this.templates.prepareForPage(this.actor(user, workspace, req), dto);
  }
}
