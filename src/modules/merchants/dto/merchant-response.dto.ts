import { ApiProperty } from '@nestjs/swagger';
import { AccountStatus } from '@prisma/client';

export class MerchantBalanceDto {
  @ApiProperty({ example: 'INR' })
  currency!: string;

  @ApiProperty({ example: 950.75, description: 'Balance in major currency units.' })
  amount!: number;
}

export class MerchantResponseDto {
  @ApiProperty({ example: 'PF-MER-A1B2C3D4' })
  publicId!: string;

  @ApiProperty({ example: 'Northwind Stores' })
  name!: string;

  @ApiProperty({ example: 'merchant@example.com' })
  email!: string;

  @ApiProperty({ enum: AccountStatus, example: AccountStatus.ACTIVE })
  status!: AccountStatus;

  @ApiProperty({ example: '2026-10-18T10:30:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ type: [MerchantBalanceDto] })
  balances!: MerchantBalanceDto[];
}
