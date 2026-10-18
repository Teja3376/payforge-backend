import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { validationMessages } from './common/validation/validation-messages';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) => new BadRequestException(validationMessages(errors)),
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('PayForge API')
    .setDescription('Customer payments, merchant balances, and platform administration.')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Paste the accessToken returned by POST /auth/login.',
      },
      'access-token',
    )
    .addTag('Auth', 'Register and sign in.')
    .addTag('Payments', 'Create and view payments.')
    .addTag('Transactions', 'Pay with card, UPI, net banking, or wallet.')
    .addTag('Merchants', 'Merchant profile and balances.')
    .addTag('Admin', 'Platform fees, account status, and refunds.')
    .addTag('Webhooks', 'Signed bank settlement callback.')
    .addTag('Health', 'Service health.')
    .addTag('Dev', 'Non-production helper that settles a mock bank charge.')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  await app.listen(process.env.PORT ?? 3000);
}

bootstrap();
