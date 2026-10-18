import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class HealthResponseDto {
  @ApiProperty({ example: 'ok' })
  status!: string;

  @ApiPropertyOptional({ example: 'up', description: 'Present on the readiness probe.' })
  database?: string;

  @ApiPropertyOptional({ example: 4, description: 'Database round-trip latency in milliseconds.' })
  latencyMs?: number;
}
