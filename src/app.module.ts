import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from './common/config/env.validation';
import { RateLimit } from './common/config/rate-limits';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { AuthGuard, TOKEN_VERIFIER } from './common/guards/auth.guard';
import { JwtTokenVerifier } from './common/guards/jwt-token-verifier';
import { AuthorizationGuard } from './common/guards/authorization.guard';
import { PrismaModule } from './database/prisma.module';
import { AdminModule } from './modules/admin/admin.module';
import { ApiKeyModule } from './modules/apikeys/api-key.module';
import { AuthModule } from './modules/auth/auth.module';
import { DevModule } from './modules/dev/dev.module';
import { FxModule } from './modules/fx/fx.module';
import { HealthModule } from './modules/health/health.module';
import { MerchantModule } from './modules/merchants/merchant.module';
import { PaymentModule } from './modules/payments/payment.module';
import { PayoutModule } from './modules/payouts/payout.module';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module';
import { RefundModule } from './modules/refunds/refund.module';
import { TransactionModule } from './modules/transactions/transaction.module';
import { WebhooksModule } from './modules/webhooks/webhook.module';

/**
 * Dev tools are opt-in.
 *
 * The original gate was `NODE_ENV === 'production'`, but nothing in the repo
 * ever set `NODE_ENV` and `start:prod` was plain `node dist/main`. That made
 * the default fail-open: deploy without remembering the env var and the
 * unauthenticated money-minting endpoint shipped with it.
 */
const devModules = process.env.ENABLE_DEV_TOOLS === 'true' ? [DevModule] : [];



@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([
      { ttl: RateLimit.global.ttl, limit: RateLimit.global.limit },
      // Separate buckets so a credential-stuffing burst on /auth/login cannot
      // consume the global budget for authenticated traffic.
      { ttl: RateLimit.auth.ttl, limit: RateLimit.auth.limit, name: 'auth' },
      { ttl: RateLimit.bank.ttl, limit: RateLimit.bank.limit, name: 'bank' },
    ]),
    PrismaModule,
    AuthModule,
    FxModule,
    MerchantModule,
    PaymentModule,
    TransactionModule,
    WebhooksModule,
    AdminModule,
    ApiKeyModule,
    PayoutModule,
    RefundModule,
    ReconciliationModule,
    HealthModule,
    ...devModules,
  ],
  providers: [
    // The guard depends on the TokenVerifier interface; bind it to the real
    // JwtService so DI has something concrete to inject.
    JwtTokenVerifier,
    { provide: TOKEN_VERIFIER, useExisting: JwtTokenVerifier },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: AuthorizationGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
