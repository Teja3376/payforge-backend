import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MinLength } from 'class-validator';

export class WebhookDto {
  @ApiProperty({ example: 'mock_6f1c0b2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b' })
  @IsString()
  @MinLength(1, { message: 'Enter the bank reference.' })
  gatewayRef!: string;

  @ApiProperty({ enum: ['SUCCESS', 'FAILED'], example: 'SUCCESS' })
  @IsIn(['SUCCESS', 'FAILED'], { message: 'Status must be SUCCESS or FAILED.' })
  status!: 'SUCCESS' | 'FAILED';
}
