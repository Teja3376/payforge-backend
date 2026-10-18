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

  /**
 * Refresh exchange rates.
 *
 * Runs four times a day rather than once. A single failure at 00:07 UTC
 * previously meant the next attempt was +24h, so one transient error cost a
 * full day of quoting against a stale rate — and since the fallback path had
 * no age bound, nothing surfaced the problem.
 *
 * `ensureToday` also runs on a short interval so a long-running process that
 * started before the daily window still converges.
 */
@Cron('7 0,6,12,18 * * *', { timeZone: 'UTC' })
  async refreshDaily() {
    try {
      await this.fetchAndStore();
    } catch (error) {
      this.log.error({ err: error }, 'scheduled exchange rate refresh failed');
    }
  }

  /**
   * Backstop for the scheduled refresh.
   *
   * Cheap: one indexed primary-key lookup, and it only fetches when today's
   * snapshot is genuinely missing.
   */
  @Cron('23 */2 * * *', { timeZone: 'UTC' })
  async refreshIfStale() {
    try {
      await this.ensureToday();
    } catch (error) {
      this.log.error({ err: error }, 'exchange rate backstop refresh failed');
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

      // The age check must apply HERE, not only on the branch below.
      //
      // The primary branch fetched `row` by today's date, so ageDays was always
      // ~0 and MAX_SNAPSHOT_AGE_DAYS was unreachable — it could only fire under
      // clock skew. The fallback branch is the only path where a rate can
      // actually be old, and it had no bound at all: a provider outage lasting
      // a week meant PayForge quoted and settled every cross-currency payment
      // at a week-old rate, silently.
      this.assertFresh(previous.rateDate, previous.rates);

      return { rateDate: previous.rateDate, rates: previous.rates as Record<string, number> };
    }

    this.assertFresh(row.rateDate, row.rates);

    return { rateDate: row.rateDate, rates: row.rates as Record<string, number> };
  }

  /**
   * Refuse to quote against a rate outside the permitted window.
   *
   * Settling at a stale rate silently misprices every cross-currency payment,
   * which is worse than refusing to quote: the merchant cannot see the damage
   * until a payout lands short.
   */
  private assertFresh(rateDate: Date, rates: unknown): void {
    const ageDays = (Date.now() - rateDate.getTime()) / (24 * 60 * 60 * 1000);
    if (ageDays > MAX_SNAPSHOT_AGE_DAYS) {
      throw ApiError.of(
        ErrorCode.EXCHANGE_RATES_UNAVAILABLE,
        'The available exchange rate is too old to quote against. Please retry shortly.',
        { meta: { rateDate: rateDate.toISOString().slice(0, 10), ageDays: Math.floor(ageDays) } },
      );
    }

    // A snapshot that parsed but contains no usable pair is as useless as a
    // missing one, and would otherwise fail much later inside quoteSettlement.
    const pairs = rates && typeof rates === 'object' ? Object.keys(rates) : [];
    if (pairs.length === 0) {
      throw ApiError.of(
        ErrorCode.EXCHANGE_RATES_UNAVAILABLE,
        'The available exchange rate snapshot is empty.',
      );
    }
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