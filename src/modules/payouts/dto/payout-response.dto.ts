import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PayoutStatus } from '@prisma/client';

export class PayoutResponseDto {
  @ApiProperty({ example: 'PF-PO-A1B2C3D4E5F6' })
  publicId!: string;

  @ApiProperty({ example: 5000.5 })
  amount!: number;

  @ApiProperty({ example: 'INR' })
  currency!: string;

  @ApiProperty({ enum: PayoutStatus, example: PayoutStatus.SCHEDULED })
  status!: PayoutStatus;

  @ApiPropertyOptional({ example: 'mock_po_6f1c0b2e3a4d4e5f' })
  externalRef!: string | null;

  @ApiPropertyOptional({ example: null })
  failureReason!: string | null;

  @ApiPropertyOptional({ example: '2026-10-19T09:00:00.000Z' })
  processedAt!: Date | null;

  @ApiProperty({ example: '2026-10-18T10:30:00.000Z' })
  createdAt!: Date;
}

export class DestinationResponseDto {
  @ApiProperty({ example: 'PF-PD-A1B2C3D4E5F6' })
  publicId!: string;

  @ApiProperty({ example: 'HDFC Bank' })
  bankName!: string;

  @ApiProperty({ example: 'Northwind Trading Ltd' })
  accountHolder!: string;

  @ApiProperty({ example: '7890', description: 'Last 4 digits only. The full number is never returned.' })
  accountLast4!: string;

  @ApiProperty({ example: 'INR' })
  currency!: string;

  @ApiProperty({ enum: ['PENDING', 'ACTIVE', 'DISABLED'] })
  status!: string;

  @ApiProperty({ example: false })
  isDefault!: boolean;

  @ApiProperty({ example: '2026-10-18T10:30:00.000Z' })
  createdAt!: Date;
}
