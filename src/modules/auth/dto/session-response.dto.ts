import { ApiProperty } from '@nestjs/swagger';

export class SessionResponseDto {
  @ApiProperty({ example: 'PF-SES-A1B2C3D4E5F6' })
  publicId!: string;

  @ApiProperty({ example: 'Mozilla/5.0', nullable: true })
  userAgent!: string | null;

  @ApiProperty({ example: '203.0.113.4', nullable: true })
  ip!: string | null;

  @ApiProperty({ example: '2026-10-18T10:30:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-10-18T10:45:00.000Z', nullable: true })
  lastUsedAt!: Date | null;

  @ApiProperty({ example: '2026-11-17T10:30:00.000Z' })
  expiresAt!: Date;
}
