import { TransactionStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdateTransactionDto {
  @IsEnum(TransactionStatus)
  status: TransactionStatus;
}
