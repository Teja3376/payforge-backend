import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { validateEnv } from './common/config/env.validation';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { PrismaModule } from './database/prisma.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { DevModule } from './modules/dev/dev.module';
import { FxModule } from './modules/fx/fx.module';
import { HealthModule } from './modules/health/health.module';
import { MerchantsModule } from './modules/merchants/merchant.module';
import { PaymentsModule } from './modules/payments/payment.module';
import { TransactionsModule } from './modules/transactions/transaction.module';
import { WebhooksModule } from './modules/webhooks/webhook.module';

const devModules = process.env.NODE_ENV === 'production' ? [] : [DevModule];

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    FxModule,
    MerchantsModule,
    PaymentsModule,
    TransactionsModule,
    WebhooksModule,
    AdminModule,
    HealthModule,
    ...devModules,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
