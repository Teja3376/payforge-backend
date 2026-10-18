import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BankModule } from '../bank/bank.module';
import { HealthController } from './health.controller';
import { MetricsService } from './metrics.service';

/**
 * Liveness, readiness and metrics.
 *
 * Readiness reports 'degraded' with 200 for an impaired-but-recoverable
 * dependency — a stale exchange rate, an unbalanced journal, a stuck payout —
 * and reserves 503 for a genuinely unserviceable process. An orchestrator that
 * restarts on degraded would restart-loop a process that is still handling most
 * traffic correctly.
 */
@Module({
  imports: [ScheduleModule, BankModule],
  controllers: [HealthController],
  providers: [MetricsService],
})
export class HealthModule {}