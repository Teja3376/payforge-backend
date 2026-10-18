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
} from 'class-validator';

export class CreatePayoutDto {
  @ApiProperty({ example: 5000.5, description: 'Amount in the destination currency.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive({ message: 'Enter an amount greater than zero.' })
  @Max(1_000_000_000)
  amount!: number;

  @ApiProperty({ example: 'INR' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z]{3}$/, { message: 'Enter a 3-letter currency code, such as INR.' })
  currency!: string;

  @ApiPropertyOptional({
    example: 'PF-PD-A1B2C3D4E5F6',
    description: 'Destination to pay out to. Defaults to the merchant default destination.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  destinationId?: string;
}

export class CreateDestinationDto {
  @ApiProperty({ example: 'HDFC Bank' })
  @IsString()
  @MaxLength(80)
  bankName!: string;

  @ApiProperty({ example: 'Northwind Trading Ltd' })
  @IsString()
  @MaxLength(80)
  accountHolder!: string;

  @ApiProperty({
    example: '50100234567890',
    description: 'Stored encrypted. Only the last 4 digits are ever returned.',
  })
  @Matches(/^\d{6,20}$/, { message: 'Enter an account number with 6 to 20 digits.' })
  accountNumber!: string;

  @ApiProperty({ example: 'HDFC0001234', description: 'IFSC or equivalent routing code. Stored encrypted.' })
  @IsString()
  @MaxLength(32)
  routingCode!: string;

  @ApiProperty({ example: 'INR' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z]{3}$/, { message: 'Enter a 3-letter currency code.' })
  currency!: string;

  @ApiPropertyOptional({ example: false, description: 'Make this the default for future payouts.' })
  @IsOptional()
  isDefault?: boolean;
}
