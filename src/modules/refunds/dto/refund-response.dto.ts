import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RefundStatus } from '@prisma/client';

export class RefundResponseDto {
  @ApiProperty({ example: 'PF-REF-A1B2C3D4E5F6' })
  publicId!: string;

  @ApiProperty({ example: 'PF-PAY-A1B2C3D4E5F6' })
  paymentId!: string;

  @ApiProperty({ example: 250.5 })
  amount!: number;

  @ApiProperty({ example: 'INR' })
  currency!: string;

  @ApiProperty({ example: 5.01, description: 'Platform fee reversed pro rata.' })
  feeReversed!: number;

  @ApiProperty({ example: 245.49, description: 'Merchant net reversed pro rata.' })
  netReversed!: number;

  @ApiProperty({ enum: RefundStatus, example: RefundStatus.SUCCEEDED })
  status!: RefundStatus;

  @ApiPropertyOptional({
    example: 'rf_9f2a1c',
    description: "The payment provider's reference for this refund.",
  })
  gatewayRefundRef!: string | null;

  @ApiPropertyOptional({
    example: 'Bank rejected the refund',
    description: 'Populated when the refund did not complete.',
  })
  failureReason!: string | null;

  @ApiPropertyOptional({ example: 'Customer returned the item' })
  reason!: string | null;

  @ApiProperty({ example: '2026-10-18T12:00:00.000Z' })
  createdAt!: Date;
}
