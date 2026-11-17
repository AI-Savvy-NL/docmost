import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class PermissionPageDto {
  @IsUUID()
  pageId: string;
}

export class PermissionRevisionDto extends PermissionPageDto {
  @Matches(/^[0-9a-f]{64}$/)
  revision: string;
}

export class PermissionGrantDto {
  @IsIn(['user', 'group'])
  type: 'user' | 'group';

  @IsUUID()
  id: string;

  @IsIn(['reader', 'writer'])
  role: 'reader' | 'writer';
}

export class SetPagePermissionDto extends PermissionRevisionDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PermissionGrantDto)
  grants: PermissionGrantDto[];
}

export class PermissionPrincipalSearchDto extends PermissionPageDto {
  @IsString()
  @MaxLength(100)
  query = '';
}
