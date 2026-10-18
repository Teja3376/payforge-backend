import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentStatus } from '@prisma/client';

export class PaymentResponseDto {
  @ApiProperty({ example: 'PF-PAY-A1B2C3D4E5F6' })
  publicId!: string;

  @ApiProperty({ example: 'PF-MER-A1B2C3D4E5F6' })
  merchantPublicId!: string;

  @ApiProperty({ example: 'Northwind Stores' })
  merchantName!: string;

  @ApiProperty({ example: 'PF-USR-D6DC83B1A2B3' })
  payerPublicId!: string;

  @ApiProperty({ example: 1580, description: 'Charged amount in major units.' })
  amount!: number;

  @ApiProperty({ example: 'JPY' })
  currency!: string;

  @ApiProperty({ example: '2026-10-18' })
  fxRateDate!: string;

  @ApiProperty({ example: '158.0012000000' })
  usdRate!: string;

  @ApiProperty({ example: '95.0757000000' })
  inrRate!: string;

  @ApiProperty({ example: 950.75 })
  settlementAmount!: number;

  @ApiProperty({ example: 'INR' })
  settlementCurrency!: string;

  @ApiProperty({ example: 200, description: 'Fee rate applied to this payment, in basis points.' })
  feeBasisPoints!: number;

  @ApiProperty({ example: 0, description: 'Amount refunded so far, in settlement currency.' })
  refundedAmount!: number;

  @ApiPropertyOptional({ example: 'Order #1001' })
  description?: string | null;

  @ApiProperty({
    enum: PaymentStatus,
    example: PaymentStatus.CREATED,
    description:
      'CREATED, PENDING, SUCCESS, FAILED, CANCELLED, EXPIRED, PARTIALLY_REFUNDED, or REFUNDED.',
  })
  status!: PaymentStatus;

  @ApiProperty({ example: '2026-10-18T10:30:00.000Z' })
  expiresAt!: Date;

  @ApiProperty({ example: '2026-10-18T10:30:00.000Z' })
  createdAt!: Date;
}

export class PaymentListResponseDto {
  @ApiProperty({ type: [PaymentResponseDto] })
  data!: PaymentResponseDto[];

  @ApiProperty({ example: false, description: 'Whether another page is available.' })
  hasMore!: boolean;

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}