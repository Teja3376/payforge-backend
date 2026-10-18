import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength } from 'class-validator';

export class RefundRequestDto {
  @ApiPropertyOptional({
    example: 250.5,
    description: 'Partial amount in settlement currency. Omit for a full refund.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  @Max(1_000_000_000)
  amount?: number;

  @ApiPropertyOptional({ example: 'Goodwill refund requested by support', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
