import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class WebhookDto {
  @ApiProperty({ example: 'mock_6f1c0b2e3a4d4e5f8a9b0c1d2e3f4a5b' })
  @IsString()
  @MinLength(1, { message: 'Enter the bank reference.' })
  gatewayRef!: string;

  @ApiProperty({ enum: ['SUCCESS', 'FAILED'] })
  @IsIn(['SUCCESS', 'FAILED'], { message: 'Status must be SUCCESS or FAILED.' })
  status!: 'SUCCESS' | 'FAILED';
}

export class BankWebhookDto extends WebhookDto {
  @ApiProperty({
    example: 1792310400,
    description: 'Unix seconds when the bank produced the event. Signatures older than 5 minutes are rejected.',
  })
  @IsInt()
  timestamp!: number;

  @ApiProperty({
    example: 'a1b2c3d4e5f6',
    description: 'Unique per delivery, so two identical payloads in the same second differ.',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/, { message: 'Enter the delivery nonce.' })
  nonce!: string;

  @ApiPropertyOptional({ example: 'do_not_honor' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  failureCode?: string;

  @ApiPropertyOptional({ example: 'The issuing bank declined this charge.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  failureMessage?: string;
}
