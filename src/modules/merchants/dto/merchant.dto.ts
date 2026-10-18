import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateMerchantDto {
  @ApiPropertyOptional({ example: 'Northwind Trading Ltd', maxLength: 80 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ example: 'IN' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z]{2}$/, { message: 'Enter a 2-letter country code, such as IN.' })
  countryCode?: string;

  @ApiPropertyOptional({
    example: 'INR',
    description: 'Administrator-only. Changing this affects future settlements.',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z]{3}$/, { message: 'Enter a 3-letter currency code.' })
  settlementCurrency?: string;
}

export class KycSubmissionDto {
  @ApiProperty({ example: 'Northwind Trading Ltd' })
  @IsString()
  @MaxLength(120)
  legalName!: string;

  @ApiPropertyOptional({ example: 'U24239MH2019PTC1234567' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  registrationNumber?: string;

  @ApiPropertyOptional({ example: '29ABCDE1234F1Z5' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  taxId?: string;

  @ApiPropertyOptional({ example: 'IN' })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  countryCode?: string;

  @ApiPropertyOptional({ example: '12 MG Road' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  addressLine1?: string;

  @ApiPropertyOptional({ example: 'Bandra West' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  addressLine2?: string;

  @ApiPropertyOptional({ example: 'Mumbai' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @ApiPropertyOptional({ example: '400050' })
  @IsOptional()
  @IsString()
  @MaxLength(12)
  postalCode?: string;
}

export class FeeScheduleDto {
  @ApiProperty({
    example: 200,
    description: 'Fee in basis points. 200 = 2.00%. Range 0–10000.',
  })
  @IsInt()
  @Min(0)
  @Max(10000)
  basisPoints!: number;
}
