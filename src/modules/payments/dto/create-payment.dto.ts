import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsNumber, IsPositive, IsString, Matches, MinLength } from 'class-validator';

export class CreatePaymentDto {
  @ApiProperty({ example: 'PF-MER-A1B2C3D4' })
  @IsString()
  @MinLength(1, { message: 'Enter the merchant id.' })
  merchantPublicId!: string;

  @ApiProperty({ example: 1580, description: 'Amount in major units of currency.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 }, { message: 'Enter an amount with at most 3 decimal places.' })
  @IsPositive({ message: 'Enter an amount greater than zero.' })
  amount!: number;

  @ApiProperty({ example: 'JPY', description: 'Charge currency. A payer in India is settled in INR.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z]{3}$/, { message: 'Enter a 3-letter currency code, such as INR.' })
  currency!: string;
}
