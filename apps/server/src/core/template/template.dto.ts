import {
  IsBoolean,
  IsDateString,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

class TemplateFieldsDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  icon?: string;

  @IsOptional()
  @IsObject()
  content?: object;
}

export class CreateTemplateDto extends TemplateFieldsDto {
  @IsOptional()
  @IsUUID()
  sourcePageId?: string;

  @IsOptional()
  @IsBoolean()
  confirmRestrictedSource?: boolean;
}

export class TemplateIdDto {
  @IsUUID()
  templateId: string;
}

export class UpdateTemplateDto extends TemplateFieldsDto {
  @IsUUID()
  templateId: string;

  @IsOptional()
  @IsDateString()
  expectedUpdatedAt?: string;
}

export class UseTemplateDto extends TemplateIdDto {
  @IsUUID()
  spaceId: string;

  @IsOptional()
  @IsUUID()
  parentPageId?: string;
}

export class PrepareTemplateDto extends TemplateIdDto {
  @IsUUID()
  pageId: string;
}
