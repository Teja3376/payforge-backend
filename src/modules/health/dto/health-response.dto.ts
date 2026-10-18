import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One dependency's state on the readiness probe. */
export class DependencyHealthDto {
  @ApiProperty({ example: 'database', description: 'Dependency name.' })
  name!: string;

  @ApiProperty({ example: 'up', enum: ['up', 'down', 'degraded'] })
  status!: 'up' | 'down' | 'degraded';

  @ApiPropertyOptional({ example: 4, description: 'Round-trip latency in milliseconds.' })
  latencyMs?: number;

  @ApiPropertyOptional({ example: 'rate snapshot is 7 days old' })
  detail?: string;
}

export class HealthResponseDto {
  @ApiProperty({
    example: 'ok',
    enum: ['ok', 'degraded', 'unavailable'],
    description:
      "'degraded' means serving traffic with an impaired dependency — for example a " +
      'stale exchange rate, which fails cross-currency payment creation but not ' +
      'same-currency traffic. Orchestrators should keep routing on degraded.',
  })
  status!: string;

  @ApiPropertyOptional({ example: 'up', description: 'Present on the readiness probe.' })
  database?: string;

  @ApiPropertyOptional({ example: 4, description: 'Database round-trip latency in milliseconds.' })
  latencyMs?: number;

  @ApiPropertyOptional({
    type: [DependencyHealthDto],
    description: 'Per-dependency detail. Present when something is not fully healthy.',
  })
  dependencies?: DependencyHealthDto[];
}