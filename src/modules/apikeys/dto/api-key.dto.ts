import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ALL_SCOPES } from '../../../common/scopes/scopes';

export class CreateApiKeyDto {
  @ApiProperty({ example: 'Checkout service — production', maxLength: 60 })
  @IsString()
  @MinLength(1, { message: 'Name this key so you can identify it later.' })
  @MaxLength(60, { message: 'Name must be 60 characters or fewer.' })
  name!: string;

  @ApiProperty({
    example: ['payments:read', 'payments:write'],
    description: `Minimum required. Valid scopes: ${ALL_SCOPES.join(', ')}`,
    isArray: true,
  })
  @IsArray()
  @ArrayNotEmpty({ message: 'Choose at least one scope.' })
  @IsString({ each: true })
  scopes!: string[];

  @ApiPropertyOptional({
    enum: ['LIVE', 'TEST'],
    default: 'LIVE',
    description: 'Test keys accept test card numbers and never move real money.',
  })
  @IsOptional()
  @IsEnum(['LIVE', 'TEST'])
  mode: 'LIVE' | 'TEST' = 'LIVE';

  @ApiPropertyOptional({ example: 90, description: 'Days until the key stops working. Omit for no expiry.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(730)
  expiresInDays?: number;
}

export class ApiKeyResponseDto {
  @ApiProperty({ example: 'PF-KEY-A1B2C3D4E5F6' })
  publicId!: string;

  @ApiProperty({ example: 'Checkout service — production' })
  name!: string;

  @ApiProperty({ example: 'pf_live_a1b2c3d4e5f6_…' })
  prefix!: string;

  @ApiProperty({ example: ['payments:read', 'payments:write'] })
  scopes!: string[];

  @ApiProperty({ enum: ['LIVE', 'TEST'] })
  mode!: string;

  @ApiProperty({ enum: ['ACTIVE', 'EXPIRED', 'REVOKED'] })
  status!: string;

  @ApiProperty({ example: '2026-10-18T10:30:00.000Z', nullable: true })
  lastUsedAt!: Date | null;

  @ApiProperty({ example: '2027-01-16T10:30:00.000Z', nullable: true })
  expiresAt!: Date | null;

  @ApiProperty({ example: '2026-10-18T10:30:00.000Z' })
  createdAt!: Date;
}

export class CreatedApiKeyDto extends ApiKeyResponseDto {
  @ApiProperty({
    example: 'pf_live_a1b2c3d4e5f6_Zm9vYmFyQmF6cXV4MTIzNDU2Nzg5MA',
    description: 'Shown once. Store it now — it cannot be retrieved again.',
  })
  key!: string;
}
