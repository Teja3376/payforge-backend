import { Controller, Get, Header, ServiceUnavailableException, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { DependencyHealthDto, HealthResponseDto } from './dto/health-response.dto';
import { PrismaService } from '../../database/prisma.service';
import { MetricsService } from './metrics.service';

@ApiTags('Health')
@Controller({
  path: 'health',
  version: [VERSION_NEUTRAL, '1'],
})
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Liveness: is the process up? Deliberately does not touch dependencies, so
   * a database blip cannot cause the orchestrator to restart a healthy process.
   */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness check' })
  @ApiOkResponse({ type: HealthResponseDto })
  health(): HealthResponseDto {
    return { status: 'ok' };
  }

  /**
   * Readiness: can the process actually serve traffic?
   *
   * Checks more than the database. Previously it returned ok for a process
   * whose database was fine but whose exchange rates had been failing to
   * refresh for days, or where every payout had been stuck — both of which
   * break real money paths while the probe stayed green.
   *
   * Returns 503 only when the process genuinely cannot serve. An impaired but
   * recoverable dependency reports 'degraded' with 200, so an orchestrator
   * does not restart-loop a process that is still handling most traffic.
   */
  @Public()
  @Get('ready')
  @ApiOperation({
    summary: 'Readiness check',
    description:
      'Verifies the database, exchange-rate freshness, and the absence of unreconciled money.',
  })
  @ApiOkResponse({ type: HealthResponseDto })
  @ApiServiceUnavailableResponse({ description: 'A hard dependency is unreachable.' })
  async ready(): Promise<HealthResponseDto> {
    const dependencies: DependencyHealthDto[] = [];

    // --- Database: hard dependency -----------------------------------------
    const startedAt = Date.now();
    let database: 'up' | 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      database = 'down';
    }
    dependencies.push({
      name: 'database',
      status: database,
      latencyMs: Date.now() - startedAt,
    });

    if (database === 'down') {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        database: 'down',
        dependencies,
      });
    }

    // --- Exchange rates: degraded, not fatal -------------------------------
    // Without a recent snapshot every cross-currency payment fails. Same-currency
    // traffic still works, so this must not take the process out of rotation.
    const rates = await this.metrics.checkExchangeRates();
    dependencies.push({
      name: 'exchange-rates',
      status: rates.ok ? 'up' : 'degraded',
      detail: rates.detail,
    });

    // --- Money integrity: degraded, not fatal -------------------------------
    const breaks = await this.metrics.checkLedgerBalance();
    dependencies.push({
      name: 'ledger-balance',
      status: breaks.ok ? 'up' : 'degraded',
      detail: breaks.detail,
    });

    // --- Payouts stuck in flight -------------------------------------------
    const payouts = await this.metrics.checkStuckPayouts();
    dependencies.push({
      name: 'payouts',
      status: payouts.ok ? 'up' : 'degraded',
      detail: payouts.detail,
    });

    const degraded = dependencies.some((d) => d.status !== 'up');

    return {
      status: degraded ? 'degraded' : 'ok',
      database: 'up',
      latencyMs: dependencies[0]?.latencyMs,
      dependencies,
    };
  }

  /**
   * Prometheus metrics.
   *
   * There was no machine-readable operational signal of any kind — no metrics,
   * no tracing, no error reporting. The only signals were log lines, so the two
   * questions that matter most (is my FX rate stale? is my money tying out?)
   * were invisible to anything that could alert on them.
   */
  @Public()
  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  @ApiOperation({ summary: 'Prometheus metrics' })
  async metricsEndpoint(): Promise<string> {
    return this.metrics.render();
  }
}

/**
 * Root level health and service liveness check for orchestrators / load balancers.
 * Matches `GET /` and `GET /v1`.
 */
@ApiTags('Root')
@Controller({
  version: [VERSION_NEUTRAL, '1'],
})
export class RootController {
  @Public()
  @Get()
  @ApiOperation({ summary: 'Root status check' })
  root(): { status: string; service: string } {
    return { status: 'ok', service: 'payforge' };
  }
}