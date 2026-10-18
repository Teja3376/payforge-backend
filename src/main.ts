import { BadRequestException, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { validationMessages } from './common/validation/validation-messages';
import { logger, newRequestId, runWithRequestContext } from './common/logger/logger';

const log = logger.child({ module: 'bootstrap' });

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  // --- URL versioning -------------------------------------------------------
  // `setVersion('1.0')` in Swagger was cosmetic; there was no prefix at all,
  // so a breaking change could never be announced. URI versioning with a
  // default of `1` yields real `/v1/...` paths and leaves room for `/v2/...`
  // without breaking anyone on v1.
  //
  // Deliberately no `setGlobalPrefix`: stacked with URI versioning that would
  // produce `/v1/v1/...`.
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  // --- Security headers -----------------------------------------------------
  app.use(
    helmet({
      // Swagger UI and the JSON spec need to load from a CDN and be framed by
      // the docs page itself.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // --- CORS -----------------------------------------------------------------
  // Explicit allowlist only. `origin: true` with credentials is the classic way
  // to hand cookie-authenticated APIs to any site on the internet.
  const origins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Api-Key',
      'Idempotency-Key',
      'X-Payforge-Signature',
      'X-Session-Id',
    ],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 3600,
  });

  // --- Request context ------------------------------------------------------
  // Every log line and every error response carries a request id, so a user
  // reporting a failure can be traced to exact server-side logs.
  app.use((request: Request, response: Response, next: NextFunction) => {
    const incoming = request.headers['x-request-id'];
    const requestId =
      typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : newRequestId();

    response.setHeader('X-Request-Id', requestId);
    const startedAt = Date.now();

    runWithRequestContext(
      {
        requestId,
        method: request.method,
        path: request.originalUrl,
        ip: request.ip,
      },
      () => {
        response.on('finish', () => {
          const durationMs = Date.now() - startedAt;
          const level = response.statusCode >= 500 ? 'warn' : 'info';
          log[level](
            {
              requestId,
              status: response.statusCode,
              durationMs,
              method: request.method,
              path: request.originalUrl,
            },
            'request completed',
          );
        });
        next();
      },
    );
  });

  // --- Validation -----------------------------------------------------------
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      exceptionFactory: (errors) => new BadRequestException(validationMessages(errors)),
    }),
  );

  // --- Shutdown -------------------------------------------------------------
  // Without this, Prisma's pool is never closed and rolling deploys leak
  // connections until Postgres refuses new ones.
  app.enableShutdownHooks();

  // Trust exactly one proxy hop. Without this, `request.ip` is the load
  // balancer's address, so the rate limiter would treat every caller as one
  // shared IP and throttle them all together.
  app.getHttpAdapter().getInstance().set?.('trust proxy', 1);

  // --- OpenAPI --------------------------------------------------------------
  const swaggerEnabled =
    process.env.SWAGGER_ENABLED !== 'false' && process.env.NODE_ENV !== 'production';

  if (swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle('PayForge API')
      .setDescription(
        'Multi-currency payment orchestration. Authenticate with an API key (`x-api-key`) for integrations, or a login token (`Authorization: Bearer`) for dashboards.',
      )
      .setVersion('1.0.0')
      .addServer(`http://localhost:${process.env.PORT ?? 3000}/v1`, 'Local')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Access token from POST /v1/auth/login. Used by dashboards and the admin console.',
        },
        'access-token',
      )
      .addApiKey(
        { type: 'apiKey', name: 'x-api-key', in: 'header' },
        'api-key',
      )
      .addGlobalParameters({
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        schema: { type: 'string', maxLength: 255 },
        description: 'Required on POST /payments, /transactions, /refunds and /payouts.',
      })
      .addTag('Auth', 'Accounts, sessions and access tokens.')
      .addTag('Payments', 'Create and inspect payments.')
      .addTag('Transactions', 'Attempt a charge against a payment.')
      .addTag('Refunds', 'Full or partial refunds.')
      .addTag('Payouts', 'Pay out merchant balances.')
      .addTag('Merchants', 'Merchant profile, balances and KYC.')
      .addTag('API Keys', 'Issue and revoke integration credentials.')
      .addTag('Webhooks', 'Outbound endpoints and the inbound bank callback.')
      .addTag('Admin', 'Platform administration and audit trail.')
      .addTag('Health', 'Liveness and readiness probes.')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: { persistAuthorization: false },
    });
    log.info('OpenAPI docs mounted at /docs');
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  log.info(
    {
      port,
      devTools: process.env.ENABLE_DEV_TOOLS === 'true',
      swagger: swaggerEnabled,
      publicIdSample: `${randomUUID().replace(/-/g, '').slice(0, 4)}…`,
    },
    'PayForge is listening',
  );
}

bootstrap().catch((error) => {
  log.error({ err: error }, 'failed to start');
  process.exit(1);
});