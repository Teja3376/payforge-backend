import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApiErrorDto {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ example: 'Bad Request' })
  error!: string;

  @ApiProperty({ example: 'Enter a valid email address.' })
  message!: string;

  @ApiPropertyOptional({ type: [String], example: ['Enter a valid email address.'] })
  details?: string[];
}
