import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class OidcStartDto {
  @IsUUID()
  providerId: string;
}

export class OidcLinkDto extends OidcStartDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  password: string;
}

export class OidcConfigureDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  issuer: string;

  @IsString()
  @MinLength(1)
  @MaxLength(512)
  clientId: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(8192)
  clientSecret?: string;

  @IsBoolean()
  isEnabled: boolean;

  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  password: string;
}
