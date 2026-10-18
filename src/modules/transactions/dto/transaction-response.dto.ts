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
  @ApiProperty({ example: 'PF-TRX-A1B2C3D4' })
  publicId!: string;

  @ApiProperty({ example: 'PF-PAY-A1B2C3D4' })
  paymentId!: string;

  @ApiProperty({ enum: PaymentMethod, example: PaymentMethod.CARD })
  method!: PaymentMethod;

  @ApiProperty({
    type: MethodDetailsResponseDto,
    nullable: true,
    description: 'Stored method details. Card responses include brand and last4, never the full card number or CVV.',
  })
  methodDetails!: MethodDetailsResponseDto | null;

  @ApiProperty({ example: 1580 })
  amount!: number;

  @ApiProperty({ example: 'JPY' })
  currency!: string;

  @ApiProperty({ example: 0 })
  fee!: number;

  @ApiProperty({ example: 0 })
  netAmount!: number;

  @ApiProperty({ enum: TransactionStatus, example: TransactionStatus.PENDING })
  status!: TransactionStatus;

  @ApiProperty({ example: 'mock_6f1c0b2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b' })
  gatewayRef!: string;

  @ApiProperty({ example: '2026-10-18T10:30:00.000Z' })
  createdAt!: Date;
}
