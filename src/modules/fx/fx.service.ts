import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../database/prisma.service';
import { utcDateOnly } from '../../common/money/money';

type ExchangeRateResponse = {
  result: string;
  base_code: string;
  conversion_rates: Record<string, number>;
};

@Injectable()
export class FxService implements OnModuleInit {
  private readonly logger = new Logger(FxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureToday();
    } catch (error) {
      this.logger.error('Exchange rate fetch failed during startup');
      this.logger.error(error instanceof Error ? error.message : error);
    }
  }

  @Cron('5 0 * * *', { timeZone: 'UTC' })
  async refreshDaily() {
    await this.fetchAndStore();
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
      throw new ServiceUnavailableException('Exchange rates for today are not available');
    }
    return { rateDate: row.rateDate, rates: row.rates as Record<string, number> };
  }

  private async fetchAndStore() {
    const apiKey = this.config.getOrThrow<string>('EXCHANGE_RATE_API_KEY');
    const response = await fetch(`https://v6.exchangerate-api.com/v6/${apiKey}/latest/USD`);
    if (!response.ok) {
      throw new Error(`Exchange rate API returned ${response.status}`);
    }
    const body = (await response.json()) as ExchangeRateResponse;
    if (body.result !== 'success' || body.base_code !== 'USD' || !body.conversion_rates) {
      throw new Error('Exchange rate API returned an unexpected payload');
    }

    const rateDate = utcDateOnly();
    await this.prisma.exchangeRateSnapshot.upsert({
      where: { rateDate },
      create: {
        rateDate,
        baseCode: 'USD',
        rates: body.conversion_rates,
      },
      update: {
        baseCode: 'USD',
        rates: body.conversion_rates,
        fetchedAt: new Date(),
      },
    });
  }
}
