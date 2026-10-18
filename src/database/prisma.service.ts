import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { logger } from '../common/logger/logger';

/**
 * Prisma client wrapper.
 *
 * Exposes `$transaction` and `$queryRaw` alongside the typed client, which
 * services need for `SELECT ... FOR UPDATE` balance locking and for the
 * append-only ledger operations the baseline migration's triggers enforce.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly log = logger.child({ module: 'prisma' });

  constructor() {
    super({
      log:
        process.env.NODE_ENV === 'development'
          ? [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }]
          : [{ emit: 'event', level: 'error' }],
    });
    this.$on('warn' as never, (event: { message: string }) => this.log.warn({ event }));
    this.$on('error' as never, (event: { message: string }) => this.log.error({ event }));
  }

  async onModuleInit() {
    await this.$connect();
  }

  /**
   * Close the pool on shutdown.
   *
   * Paired with `app.enableShutdownHooks()` in `main.ts`. Without both,
   * rolling deploys leak connections until Postgres refuses new ones.
   */
  async onModuleDestroy() {
    await this.$disconnect();
  }
}