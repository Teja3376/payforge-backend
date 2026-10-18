import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class RegisterMerchantDto {
  @ApiProperty({ example: 'Northwind Stores' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'Enter the merchant name.' })
  @MaxLength(80, { message: 'Merchant name must be 80 characters or fewer.' })
  name!: string;

  @ApiProperty({ example: 'merchant@example.com' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'Enter a valid email address.' })
  email!: string;

  @ApiProperty({ example: 'password123', minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters.' })
  password!: string;

  @ApiProperty({ example: 'IN' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z]{2}$/, { message: 'Enter a 2-letter country code, such as IN.' })
  countryCode!: string;
}
