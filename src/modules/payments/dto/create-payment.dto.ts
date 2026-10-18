import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MAX_MAJOR_AMOUNT } from '../../../common/money/money';

export class CreatePaymentDto {
  @ApiProperty({ example: 'PF-MER-A1B2C3D4E5F6' })
  @IsString()
  @MinLength(1, { message: 'Enter the merchant id.' })
  @Matches(/^PF-[A-Z]{2,8}-[0-9A-HJKMNP-TV-Z]{12}$/, { message: 'That merchant id is not valid.' })
  merchantPublicId!: string;

  @ApiProperty({ example: 1580, description: 'Amount in major units of `currency`.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 }, { message: 'Enter an amount with at most 3 decimal places.' })
  @IsPositive({ message: 'Enter an amount greater than zero.' })
  // Without an upper bound `1e308` produced a 311-digit BigInt and a 500 from
  // the database driver — a cheap way to generate 500s and flood logs.
  @Max(MAX_MAJOR_AMOUNT, {
    message: `Amount must be ${MAX_MAJOR_AMOUNT.toLocaleString()} or fewer.`,
  })
  amount!: number;

  @ApiProperty({ example: 'JPY', description: 'Charge currency, ISO 4217.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z]{3}$/, { message: 'Enter a 3-letter currency code, such as INR.' })
  currency!: string;

  @ApiPropertyOptional({ example: 'Order #1001', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'Description must be 200 characters or fewer.' })
  description?: string;

  @ApiPropertyOptional({
    example: { orderId: '1001' },
    description: 'Your own reference data. Echoed back on payment webhooks.',
  })
  @IsOptional()
  metadata?: Record<string, unknown>;
}
