import { ApiProperty } from '@nestjs/swagger';
import { PaymentStatus } from '@prisma/client';

export class PaymentResponseDto {
  @ApiProperty({ example: 'PF-PAY-A1B2C3D4' })
  publicId!: string;

  @ApiProperty({ example: 'PF-MER-A1B2C3D4' })
  merchantPublicId!: string;

  @ApiProperty({ example: 'Northwind Stores' })
  merchantName!: string;

  @ApiProperty({ example: 'PF-USR-D6DC83B1' })
  payerPublicId!: string;

  @ApiProperty({ example: 1580, description: 'Charged amount in major currency units.' })
  amount!: number;

  @ApiProperty({ example: 'JPY' })
  currency!: string;

  @ApiProperty({ example: '2026-10-18' })
  fxRateDate!: string;

  @ApiProperty({ example: '158.0012' })
  usdRate!: string;

  @ApiProperty({ example: '95.0757' })
  inrRate!: string;

  @ApiProperty({ example: 950.75, description: 'Amount the merchant is settled, in settlementCurrency.' })
  settlementAmount!: number;

  @ApiProperty({ example: 'INR' })
  settlementCurrency!: string;

  @ApiProperty({ enum: PaymentStatus, example: PaymentStatus.CREATED })
  status!: PaymentStatus;

  @ApiProperty({ example: '2026-10-18T10:30:00.000Z' })
  createdAt!: Date;
}
