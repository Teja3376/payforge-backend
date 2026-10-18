import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CardBrand, PaymentMethod, TransactionStatus, WalletProvider } from '@prisma/client';

export class MethodDetailsResponseDto {
  @ApiPropertyOptional({ example: 'Ada Lovelace' })
  holderName?: string;

  @ApiPropertyOptional({ enum: CardBrand, example: CardBrand.VISA })
  brand?: CardBrand;

  @ApiPropertyOptional({ example: '1111' })
  last4?: string;

  @ApiPropertyOptional({ example: 12 })
  expiryMonth?: number;

  @ApiPropertyOptional({ example: 2030 })
  expiryYear?: number;

  @ApiPropertyOptional({ example: 'ada@okaxis' })
  vpa?: string;

  @ApiPropertyOptional({ example: 'HDFC' })
  bankCode?: string;

  @ApiPropertyOptional({ enum: WalletProvider, example: WalletProvider.PAYTM })
  provider?: WalletProvider;
}

export class TransactionResponseDto {
  @ApiProperty({ example: 'PF-TRX-A1B2C3D4E5F6' })
  publicId!: string;

  @ApiProperty({ example: 'PF-PAY-A1B2C3D4E5F6' })
  paymentId!: string;

  @ApiProperty({ example: 'PF-MER-A1B2C3D4E5F6' })
  merchantPublicId!: string;

  @ApiProperty({ enum: PaymentMethod, example: PaymentMethod.CARD })
  method!: PaymentMethod;

  @ApiProperty({
    type: MethodDetailsResponseDto,
    nullable: true,
    description:
      'Stored method details. For cards this is brand and last 4 only — never the full number or CVV.',
  })
  methodDetails!: MethodDetailsResponseDto | null;

  @ApiProperty({ example: 950.75, description: 'Amount in settlement currency.' })
  amount!: number;

  @ApiProperty({ example: 'INR' })
  currency!: string;

  @ApiProperty({ example: 19.02 })
  fee!: number;

  @ApiProperty({ example: 931.73 })
  netAmount!: number;

  @ApiProperty({ example: 200 })
  feeBasisPoints!: number;

  @ApiProperty({
    enum: TransactionStatus,
    example: TransactionStatus.PENDING,
    description: 'PENDING, SUCCESS, FAILED, VOIDED, or EXPIRED.',
  })
  status!: TransactionStatus;

  @ApiProperty({ example: 'DO_NOT_HONOR', nullable: true })
  failureCode!: string | null;

  @ApiProperty({ example: 'The bank declined the charge.', nullable: true })
  failureMessage!: string | null;

  @ApiProperty({ example: '2026-10-18T10:31:00.000Z', nullable: true })
  settledAt!: Date | null;

  @ApiProperty({ example: '2026-10-18T10:30:00.000Z' })
  createdAt!: Date;
}
