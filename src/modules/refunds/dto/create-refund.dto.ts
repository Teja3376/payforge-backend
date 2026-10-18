import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
} from 'class-validator';

export class CreateRefundDto {
  @ApiProperty({
    example: 'PF-PAY-A1B2C3D4E5F6',
    description: 'Omit to refund the full remaining amount.',
  })
  @IsString()
  @Matches(/^PF-PAY-[0-9A-HJKMNP-TV-Z]{12}$/, { message: 'That payment id is not valid.' })
  paymentId!: string;

  @ApiPropertyOptional({
    example: 250.5,
    description: 'Partial amount in settlement currency. Omit for a full refund.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 }, { message: 'Enter an amount with at most 3 decimal places.' })
  @IsPositive({ message: 'Enter an amount greater than zero.' })
  @Max(1_000_000_000)
  amount?: number;

  @ApiPropertyOptional({ example: 'Customer returned the item', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
