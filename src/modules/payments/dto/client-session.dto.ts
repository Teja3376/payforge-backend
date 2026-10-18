import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CardBrand } from '@prisma/client';

export class CreateClientSessionDto {
  @ApiPropertyOptional({
    example: 'PF-PAY-A1B2C3D4E5F6',
    description: 'Bind the session to a specific payment when the intent is already known.',
  })
  @IsOptional()
  @IsString()
  paymentId?: string;
}

export class ClientSessionResponseDto {
  @ApiProperty({
    example: 'cs_test_9f2c1a7b4e6d0358aa11',
    description: 'Pass to @payforge/react. Valid for 15 minutes and single-use.',
  })
  clientSecret!: string;

  @ApiProperty({ example: '2026-10-18T10:45:00.000Z' })
  expiresAt!: Date;

  @ApiProperty({ example: 'mock_ts_6f1c0b2e3a4d4e5f8a9b0c1d2e3f4a5b' })
  providerSession!: string;
}

export class SavePaymentMethodDto {
  @ApiProperty({
    example: 'tok_mock_6f1c0b2e3a4d4e5f',
    description: 'Single-use token returned by the provider iframe. The PAN never reaches PayForge.',
  })
  @IsString()
  @MaxLength(255)
  gatewayToken!: string;

  @ApiPropertyOptional({ example: 'cus_12345', description: 'Your identifier for this customer.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  customerRef?: string;

  @ApiPropertyOptional({ enum: CardBrand, example: CardBrand.VISA })
  @IsOptional()
  @IsEnum(CardBrand)
  brand?: CardBrand;

  @ApiPropertyOptional({ example: '4242' })
  @IsOptional()
  @Matches(/^\d{4}$/, { message: 'last4 must be 4 digits.' })
  last4?: string;

  @ApiPropertyOptional({ example: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  expiryMonth?: number;

  @ApiPropertyOptional({ example: 2030 })
  @IsOptional()
  @IsInt()
  @Min(2020)
  @Max(2100)
  expiryYear?: number;

  @ApiPropertyOptional({ example: 'Ada Lovelace' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  holderName?: string;
}

export class SavedPaymentMethodResponseDto {
  @ApiProperty({ example: 'PF-PM-A1B2C3D4E5F6' })
  publicId!: string;

  @ApiPropertyOptional({ example: 'cus_12345' })
  customerRef!: string | null;

  @ApiProperty({ example: 'CARD' })
  type!: string;

  @ApiProperty({ enum: CardBrand, example: CardBrand.VISA, nullable: true })
  brand!: CardBrand | null;

  @ApiProperty({ example: '4242', nullable: true })
  last4!: string | null;

  @ApiProperty({ example: 12, nullable: true })
  expiryMonth!: number | null;

  @ApiProperty({ example: 2030, nullable: true })
  expiryYear!: number | null;

  @ApiProperty({ example: 'Ada Lovelace', nullable: true })
  holderName!: string | null;

  @ApiProperty({ example: 'ACTIVE' })
  status!: string;

  @ApiProperty({ example: '2026-10-18T10:30:00.000Z' })
  createdAt!: Date;
}
