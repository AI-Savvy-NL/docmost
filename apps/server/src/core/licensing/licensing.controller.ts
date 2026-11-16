import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { MAX_LICENSE_LENGTH } from '@wikisavvy/license';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '../../database/types/entity.types';
import { UserRole } from '../../common/helpers/types/permission';
import { LicensingService } from './licensing.service';

export class ActivateWikisavvyLicenseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_LICENSE_LENGTH)
  license: string;
}

@Controller('wikisavvy/licensing')
@UseGuards(JwtAuthGuard)
export class LicensingController {
  constructor(private readonly licensing: LicensingService) {}

  private assertOwner(user: User, workspace: Workspace) {
    if (user.workspaceId !== workspace.id || user.role !== UserRole.OWNER)
      throw new ForbiddenException();
  }

  @Post('status')
  @HttpCode(HttpStatus.OK)
  async status(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertOwner(user, workspace);
    return this.licensing.status(workspace.id);
  }

  @Post('activate')
  @HttpCode(HttpStatus.OK)
  async activate(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Body() dto: ActivateWikisavvyLicenseDto,
  ) {
    this.assertOwner(user, workspace);
    return this.licensing.activate(workspace.id, user.id, dto.license);
  }

  @Post('remove')
  @HttpCode(HttpStatus.OK)
  async remove(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertOwner(user, workspace);
    return this.licensing.remove(workspace.id, user.id);
  }
}
