import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class CreateEndpointDto {
  @ApiProperty({ example: 'https://example.com/webhooks/payforge' })
  @IsUrl({ require_protocol: true, protocols: ['https'] }, {
    message: 'Enter a valid https:// URL.',
  })
  url!: string;

  @ApiProperty({
    example: ['PAYMENT_SUCCEEDED', 'PAYMENT_FAILED'],
    description: 'Event names to subscribe to, or ["*"] for all.',
    isArray: true,
  })
  @IsArray()
  @ArrayNotEmpty({ message: 'Subscribe to at least one event.' })
  @IsString({ each: true })
  events!: string[];

  @ApiPropertyOptional({ example: 'Production order service' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  description?: string;
}

export class UpdateEndpointDto {
  @ApiPropertyOptional({ example: 'https://example.com/webhooks/payforge-v2' })
  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  url?: string;

  @ApiPropertyOptional({ example: ['PAYMENT_SUCCEEDED'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];

  @ApiPropertyOptional({ enum: ['ACTIVE', 'DISABLED'] })
  @IsOptional()
  @IsString()
  status?: 'ACTIVE' | 'DISABLED';

  @ApiPropertyOptional({ example: 'Staging endpoint' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  description?: string;
}

export class EndpointResponseDto {
  @ApiProperty({ example: 'PF-WH-A1B2C3D4E5F6' })
  publicId!: string;

  @ApiProperty({ example: 'https://example.com/webhooks/payforge' })
  url!: string;

  @ApiProperty({ example: ['PAYMENT_SUCCEEDED'] })
  events!: string[];

  @ApiProperty({ enum: ['ACTIVE', 'DISABLED'] })
  status!: string;

  @ApiPropertyOptional({ example: 'Production order service' })
  description!: string | null;

  @ApiProperty({ example: 0, description: 'Consecutive delivery failures.' })
  failureCount!: number;

  @ApiProperty({ example: '2026-10-18T10:30:00.000Z' })
  createdAt!: Date;
}

export class CreatedEndpointDto extends EndpointResponseDto {
  @ApiProperty({
    example: 'whsec_9f2c1a7b4e6d0358aa11',
    description: 'Signing secret, shown once. Store it securely.',
  })
  secret!: string;
}

export class DeliveryResponseDto {
  @ApiProperty({ example: 'PF-DELIVERY-A1B2C3D4E5F6' })
  publicId!: string;

  @ApiProperty({ example: 'evt_9f2c1a7b4e6d0358aa11cc' })
  eventId!: string;

  @ApiProperty({ example: 'PAYMENT_SUCCEEDED' })
  eventType!: string;

  @ApiProperty({ enum: ['PENDING', 'DELIVERED', 'FAILED', 'DEAD'] })
  status!: string;

  @ApiProperty({ example: 1 })
  attempts!: number;

  @ApiPropertyOptional({ example: 500 })
  lastStatusCode!: number | null;

  @ApiPropertyOptional({ example: 'fetch failed' })
  lastError!: string | null;

  @ApiPropertyOptional({ example: '2026-10-18T10:31:02.000Z' })
  deliveredAt!: Date | null;

  @ApiProperty({ example: '2026-10-18T10:31:00.000Z' })
  createdAt!: Date;
}
