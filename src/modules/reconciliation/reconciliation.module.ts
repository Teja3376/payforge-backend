import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BankModule } from '../bank/bank.module';
import { ReconciliationService } from './reconciliation.service';

/**
 * Scheduled integrity checks.
 *
 * ReconciliationService owns the nightly journal-balance proof, the stranded
 * refund and orphaned charge sweeps, and payment expiry. It is the component
 * that makes the rest of the money machinery observable: without it, a payout
 * that debits and never transfers, a refund that reverses only the ledger, and
 * a charge stranded after a failed commit all fail identically and silently.
 */
@Module({
  imports: [ScheduleModule, BankModule],
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}