import { Module } from '@nestjs/common';
import { BANK_PORT } from './bank.port';
import { MockBankAdapter } from './mock-bank.adapter';

@Module({
  providers: [
    MockBankAdapter,
    { provide: BANK_PORT, useExisting: MockBankAdapter },
  ],
  exports: [BANK_PORT],
})
export class BankModule {}
