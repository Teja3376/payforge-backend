import { Module } from '@nestjs/common';
import { BANK_PORT } from './bank.port';
import { MockBankAdapter } from './mock-bank.adapter';

/**
 * Binds the gateway adapter.
 *
 * A real deployment swaps `MockBankAdapter` for a live PSP implementation
 * behind the same `BANK_PORT` token — that is the whole point of the seam.
 */
@Module({
  providers: [MockBankAdapter, { provide: BANK_PORT, useExisting: MockBankAdapter }],
  exports: [BANK_PORT, MockBankAdapter],
})
export class BankModule {}
