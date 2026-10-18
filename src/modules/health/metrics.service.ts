import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BANK_PORT, type BankPort } from '../bank/bank.port';
import { PrismaService } from '../../database/prisma.service';
import { logger } from '../../common/logger/logger';

/** Exchange rates older than this make cross-currency payments fail. */
const MAX_RATE_AGE_MS = 5 * 24 * 60 * 60 * 1000;

type Check = { ok: boolean; detail?: string };

/**
 * Operational metrics and dependency health.
 *
 * PayForge had no machine-readable signal at all: no `/metrics`, no tracing, no
 * error reporting. Everything an operator could learn came from log lines, so
 * the two questions that determine whether money is safe — is the exchange
 * rate stale, does the journal still balance — could not be alerted on and
 * were invisible to the readiness probe.
 *
 * Metrics are rendered in the Prometheus text exposition format without a
 * client dependency. The metric set here is deliberately small: process and
 * HTTP shape, plus the money invariants.
 */
@Injectable()
export class MetricsService {
  private readonly log = logger.child({ module: 'metrics' });
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BANK_PORT) private readonly bank: BankPort,
  ) {
    this.registerProcessMetrics();
  }

  /** Increment a counter. Called from the request pipeline and the workers. */
  increment(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = this.seriesKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  /** Set a gauge to an absolute value. */
  set(name: string, value: number, labels: Record<string, string> = {}): void {
    this.gauges.set(this.seriesKey(name, labels), value);
  }

  // --- Dependency checks --------------------------------------------------

  /**
   * Exchange-rate freshness.
   *
   * Surfaced on the readiness probe because a stale rate silently misprices
   * every cross-currency payment: the quote looks fine and settles wrong.
   */
  async checkExchangeRates(): Promise<Check> {
    const latest = await this.prisma.exchangeRateSnapshot.findFirst({
      orderBy: { rateDate: 'desc' },
      select: { rateDate: true },
    });

    if (!latest) {
      return { ok: false, detail: 'no exchange rate snapshot has ever been stored' };
    }

    const ageMs = Date.now() - latest.rateDate.getTime();
    if (ageMs > MAX_RATE_AGE_MS) {
      const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      return { ok: false, detail: `most recent rate is ${days} days old` };
    }
    return { ok: true };
  }

  /**
   * The double-entry invariant, per currency.
   *
   * Exposed as a gauge rather than only logged so an imbalance can page
   * someone. This is the check that would have caught the single-entry journal
   * and a payout that debits without transferring.
   */
  async checkLedgerBalance(): Promise<Check> {
    const rows = await this.prisma.$queryRaw<Array<{ currency: string; delta: bigint }>>`
      SELECT "currency",
             COALESCE(SUM("amount") FILTER (WHERE "type" = 'CREDIT'), 0)
           - COALESCE(SUM("amount") FILTER (WHERE "type" = 'DEBIT'), 0) AS "delta"
      FROM "Ledgers"
      GROUP BY "currency"
      HAVING COALESCE(SUM("amount") FILTER (WHERE "type" = 'CREDIT'), 0)
           <> COALESCE(SUM("amount") FILTER (WHERE "type" = 'DEBIT'), 0)
    `;

    for (const row of rows) {
      this.set('payforge_ledger_imbalance_minor', Number(row.delta), { currency: row.currency });
    }

    if (rows.length > 0) {
      return {
        ok: false,
        detail: `${rows.length} currency/currencies do not balance: ${rows
          .map((r) => `${r.currency} off by ${r.delta}`)
          .join(', ')}`,
      };
    }
    return { ok: true };
  }

  /** Payouts whose outcome the platform does not know. */
  async checkStuckPayouts(): Promise<Check> {
    const cutoff = new Date(Date.now() - 15 * 60_000);
    const count = await this.prisma.payout.count({
      where: { status: 'IN_TRANSIT', updatedAt: { lt: cutoff } },
    });
    this.set('payforge_payouts_in_flight_stuck', count);

    if (count > 0) {
      return { ok: false, detail: `${count} payout(s) stuck in flight past the recovery window` };
    }
    return { ok: true };
  }

  /** Refunds interrupted between reserving the key and posting the reversal. */
  async checkStrandedRefunds(): Promise<Check> {
    const cutoff = new Date(Date.now() - 15 * 60_000);
    const count = await this.prisma.refund.count({
      where: { status: 'PENDING', updatedAt: { lt: cutoff } },
    });
    this.set('payforge_refunds_stranded', count);
    return count > 0
      ? { ok: false, detail: `${count} refund(s) awaiting resolution` }
      : { ok: true };
  }

  /** Charges whose callback never arrived. */
  async checkOrphanedCharges(): Promise<Check> {
    const cutoff = new Date(Date.now() - 60 * 60_000);
    const count = await this.prisma.transactions.count({
      where: { status: 'PENDING', updatedAt: { lt: cutoff } },
    });
    this.set('payforge_transactions_pending_stale', count);
    return count > 0
      ? { ok: false, detail: `${count} charge(s) with no provider callback` }
      : { ok: true };
  }

  // --- Sampling -----------------------------------------------------------

  /**
   * Refresh the sampled gauges.
   *
   * Counters come from the request pipeline and workers; gauges that require a
   * query are sampled here rather than on every scrape, so a Prometheus
   * interval of 15s does not become 15s of database load per instance.
   */
  @Cron('*/30 * * * *', { timeZone: 'UTC' })
  async sample(): Promise<void> {
    try {
      const [settlements, refunds, payouts, webhooks] = await Promise.all([
        this.prisma.transactions.count({ where: { status: 'SUCCESS' } }),
        this.prisma.refund.count({ where: { status: 'SUCCEEDED' } }),
        this.prisma.payout.count({ where: { status: 'PAID' } }),
        this.prisma.webhookDelivery.count({ where: { status: 'DEAD' } }),
      ]);

      this.set('payforge_transactions_settled_total', settlements);
      this.set('payforge_refunds_succeeded_total', refunds);
      this.set('payforge_payouts_paid_total', payouts);
      this.set('payforge_webhook_deliveries_dead_total', webhooks);

      await this.checkExchangeRates();
      await this.checkLedgerBalance();
      await this.checkStuckPayouts();
      await this.checkStrandedRefunds();
      await this.checkOrphanedCharges();
    } catch (error) {
      // Sampling must never take the process down.
      this.log.error({ err: error }, 'metrics sampling failed');
    }
  }

  // --- Rendering ----------------------------------------------------------

  /** Render the Prometheus text exposition format. */
  async render(): Promise<string> {
    // Refresh on scrape so a freshly-started process does not report zeroes.
    await this.sample().catch(() => undefined);

    const lines: string[] = [];

    for (const [key, help, type] of HELP) {
      lines.push(`# HELP ${key} ${help}`);
      lines.push(`# TYPE ${key} ${type}`);
    }

    for (const [key, value] of [...this.counters].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`${key} ${value}`);
    }
    for (const [key, value] of [...this.gauges].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`${key} ${value}`);
    }

    return `${lines.join('\n')}\n`;
  }

  private registerProcessMetrics(): void {
    const memory = process.memoryUsage();
    this.set('payforge_process_resident_memory_bytes', memory.rss);
    this.set('payforge_process_heap_used_bytes', memory.heapUsed);
    this.set('payforge_process_uptime_seconds', Math.floor(process.uptime()));
    this.set('payforge_process_node_version_major', Number(process.versions.node.split('.')[0]));
  }

  private seriesKey(name: string, labels: Record<string, string>): string {
    const entries = Object.entries(labels).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return name;
    const rendered = entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
      .join(',');
    return `${name}{${rendered}}`;
  }
}

/** Metric catalogue. Exported so the README and dashboards can reference it. */
const HELP: Array<[string, string, 'counter' | 'gauge']> = [
  ['payforge_process_resident_memory_bytes', 'Resident set size in bytes.', 'gauge'],
  ['payforge_process_heap_used_bytes', 'V8 heap in use.', 'gauge'],
  ['payforge_process_uptime_seconds', 'Process uptime.', 'gauge'],
  ['payforge_process_node_version_major', 'Node major version.', 'gauge'],
  ['payforge_http_requests_total', 'HTTP requests handled, by route and status.', 'counter'],
  ['payforge_http_request_duration_ms', 'HTTP request duration, by route.', 'gauge'],
  ['payforge_transactions_settled_total', 'Charges settled successfully.', 'gauge'],
  ['payforge_refunds_succeeded_total', 'Refunds completed at the provider.', 'gauge'],
  ['payforge_payouts_paid_total', 'Payouts transferred.', 'gauge'],
  ['payforge_payouts_in_flight_stuck', 'Payouts stuck in flight past the recovery window.', 'gauge'],
  ['payforge_refunds_stranded', 'Refunds awaiting resolution.', 'gauge'],
  ['payforge_transactions_pending_stale', 'Charges with no provider callback.', 'gauge'],
  ['payforge_webhook_deliveries_dead_total', 'Webhook deliveries that exhausted retries.', 'gauge'],
  ['payforge_webhook_deliveries_attempted_total', 'Webhook delivery attempts.', 'counter'],
  ['payforge_ledger_imbalance_minor', 'Credit minus debit per currency. Non-zero is an alert.', 'gauge'],
];