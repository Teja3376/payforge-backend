import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The single error shape returned by every failing endpoint.
 *
 * `code` is the stable contract — branch on it. `message` is written for
 * humans and may be reworded without a version bump.
 */
export class ApiErrorDto {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ example: 'Bad Request' })
  error!: string;

  @ApiProperty({
    example: 'PAYMENT_HAS_OPEN_TRANSACTION',
    description: 'Stable machine-readable error code. Safe to branch on.',
  })
  code!: string;

  @ApiProperty({ example: 'This payment already has a transaction in progress.' })
  message!: string;

  @ApiProperty({
    example: 'req_9f2c1a7b4e6d0358aa11',
    description: 'Quote this when contacting support. Matches the `requestId` in server logs.',
  })
  requestId!: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['Enter a valid email address.'],
    description: 'Field-level messages. Present when more than one field failed validation.',
  })
  details?: string[];
}

export class PaginatedMetaDto {
  @ApiProperty({ example: false, description: 'Whether another page is available.' })
  hasMore!: boolean;

  @ApiProperty({
    example: null,
    nullable: true,
    description: 'Pass back as `cursor` to fetch the next page. Null on the last page.',
  })
  nextCursor!: string | null;
}