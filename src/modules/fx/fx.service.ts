import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { utcDateOnly } from '../../common/money/money';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { logger } from '../../common/logger/logger';
import { PrismaService } from '../../database/prisma.service';

type ExchangeRateResponse = {
  result: string;
  base_code: string;
  conversion_rates: Record<string, number>;
};

const FETCH_TIMEOUT_MS = 8000;
const MAX_SNAPSHOT_AGE_DAYS = 5;

@Injectable()
export class FxService implements OnModuleInit {
  private readonly log = logger.child({ module: 'fx' });

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureToday();
    } catch (error) {
      // Boot must not fail on a flaky third party, but it must be loud.
      this.log.error({ err: error }, 'exchange rate fetch failed during startup');
    }
  }

  @Cron('7 0 * * *', { timeZone: 'UTC' })
  async refreshDaily() {
    try {
      await this.fetchAndStore();
    } catch (error) {
      this.log.error({ err: error }, 'scheduled exchange rate refresh failed');
    }
  }

  async ensureToday() {
    const rateDate = utcDateOnly();
    const existing = await this.prisma.exchangeRateSnapshot.findUnique({ where: { rateDate } });
    if (!existing) {
      await this.fetchAndStore();
    }
  }

  async ratesForToday(): Promise<{ rateDate: Date; rates: Record<string, number> }> {
    const rateDate = utcDateOnly();
    const row = await this.prisma.exchangeRateSnapshot.findUnique({ where: { rateDate } });

    if (!row) {
      // Fall back to the most recent snapshot rather than failing payment
      // creation outright; a weekend or provider outage should degrade to
      // "yesterday's rate", not to a total outage.
      const previous = await this.latestSnapshot();
      if (!previous) {
        throw ApiError.of(ErrorCode.EXCHANGE_RATES_UNAVAILABLE);
      }
      return { rateDate: previous.rateDate, rates: previous.rates as Record<string, number> };
    }

    const ageDays = (Date.now() - row.rateDate.getTime()) / (24 * 60 * 60 * 1000);
    if (ageDays > MAX_SNAPSHOT_AGE_DAYS) {
      throw ApiError.of(
        ErrorCode.EXCHANGE_RATES_UNAVAILABLE,
        'The available exchange rate is too old to quote against. Please retry shortly.',
      );
    }

    return { rateDate: row.rateDate, rates: row.rates as Record<string, number> };
  }

  /** Exposed so merchants can pre-quote before creating a payment. */
  async latestSnapshot() {
    return this.prisma.exchangeRateSnapshot.findFirst({ orderBy: { rateDate: 'desc' } });
  }

  private async fetchAndStore() {
    const apiKey = this.config.getOrThrow<string>('EXCHANGE_RATE_API_KEY');
    const baseUrl =
      this.config.get<string>('FX_PROVIDER_URL') ??
      'https://v6.exchangerate-api.com/v6';

    // Without an AbortSignal an unreachable provider hangs bootstrap and every
    // payment creation until the socket times out.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}/${apiKey}/latest/USD`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Exchange rate provider returned ${response.status}`);
      }
      const body = (await response.json()) as ExchangeRateResponse;
      if (body.result !== 'success' || body.base_code !== 'USD' || !body.conversion_rates) {
        throw new Error('Exchange rate provider returned an unexpected payload');
      }

      const rateDate = utcDateOnly();
      await this.prisma.exchangeRateSnapshot.upsert({
        where: { rateDate },
        create: { rateDate, baseCode: 'USD', rates: body.conversion_rates },
        update: { baseCode: 'USD', rates: body.conversion_rates, fetchedAt: new Date() },
      });
      this.log.info({ rateDate: rateDate.toISOString() }, 'exchange rates refreshed');
    } finally {
      clearTimeout(timeout);
    }
  }
}